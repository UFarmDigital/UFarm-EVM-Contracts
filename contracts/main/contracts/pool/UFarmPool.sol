// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// INTERFACES
import {AssetsStructs} from '../../shared/AssetController.sol';
import {ICoreWhitelist} from '../core/CoreWhitelist.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import {IERC721Controller, IERC20SynthController} from '../controllers/IController.sol';
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {IUFarmFund} from '../fund/IUFarmFund.sol';
import {IUFarmPool} from './IUFarmPool.sol';
import {IPoolAdmin} from './IPoolAdmin.sol';
import {IPriceOracle} from '../oracle/IPriceOracle.sol';
import {Permissions} from '../permissions/Permissions.sol';

/// CONTRACTS
import {ECDSARecover} from '../../shared/ECDSARecover.sol';
import {ERC20Upgradeable as ERC20} from '@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol';
import {ERC721HolderUpgradeable as ERC721Holder} from '@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol';
import {NZGuard} from '../../shared/NZGuard.sol';
import {PoolWhitelist} from './PoolWhitelist.sol';
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import {UFarmErrors} from '../../shared/UFarmErrors.sol';
import {UFarmOwnableUUPSBeacon} from '../../shared/UFarmOwnableUUPSBeacon.sol';
import {UFarmPermissionsModel} from '../permissions/UFarmPermissionsModel.sol';

/// LIBRARIES
import {AssetLib} from '../../shared/AssetController.sol';
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {PerformanceFeeLib} from './PerformanceFeeLib.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {SafeOPS} from '../../shared/SafeOPS.sol';

/**
 * @title UFarmPool contract
 * @author https://ufarm.digital/
 * @notice Pool implementation contract for UFarm Funds
 */
contract UFarmPool is
	IUFarmPool,
	ERC20,
	UFarmErrors,
	PoolWhitelist,
	ERC721Holder,
	ReentrancyGuard,
	NZGuard,
	ECDSARecover,
	UFarmOwnableUUPSBeacon
{
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;
	using AssetLib for AssetsStructs.Assets;
	using SafeERC20 for IERC20;

	uint256 private constant HALF = 5e17;
	uint256 private constant ONE = 1e18;
	uint256 private constant TEN_PERCENTS = 1e17;
	uint256 private constant YEAR = 365 days;
	uint256 public constant MAX_TOKEN_WEIGHT = 25;

	PoolStatus public status;

	address private _ufarmCore;

	address public ufarmFund;
	address public valueToken;
	address public poolAdmin;

	uint256 public highWaterMark;
	uint256 public lastAccrual;

	/**
	 * @inheritdoc IUFarmPool
	 */
	address public _protocolTarget;
	bytes32 public _withdrawalHash;
	bytes32 private protocolInUse;

	/**
	 * @notice Mapping of the pending deposit requests to receiving timestamp
	 */
	mapping(bytes32 => uint256) public pendingWithdrawalsRequests;
	mapping(bytes32 => bool) private __usedDepositsRequests;
	mapping(bytes32 => bool) private __usedWithdrawalsRequests;
	AssetsStructs.Assets private __assets;

	uint8 private __decimals;
	bool private __isMangerAction;

	modifier keepWithdrawalHash(bytes32 _withdHash) {
		_withdrawalHash = _withdHash;
		_;
		delete _withdrawalHash;
	}

	/**
	 * @notice Allows function to be called only from the controller
	 */
	modifier calledByController() {
		if (msg.sender != address(this)) revert NotDelegateCalled();
		_;
	}

	/**
	 * @notice Reverts if value Pool status is not equal to `_onlyStatus`
	 */
	modifier onlyStatus(PoolStatus _onlyStatus) {
		_statusIs(_onlyStatus);
		_;
	}

	/**
	 * @notice Reverts if the UFarm platform is paused
	 */
	modifier ufarmIsNotPaused() {
		_ufarmIsNotPaused();
		_;
	}

	/**
	 * @notice Reverts if caller is not a fund member
	 */
	modifier onlyFundMember() {
		_isCallerFundMember();
		_;
	}

	modifier onlyActiveFund() {
		_checkActiveFund();
		_;
	}

	function __init_UFarmPool(
		CreationSettingsWithLinks memory _settings,
		address _poolAdmin
	) external initializer checkDelegateCall {
		__ERC20_init(_settings.params.name, _settings.params.symbol);
		__ReentrancyGuard_init();
		__init_UFarmOwnableUUPSBeacon();
		__init_UFarmPool_unchained(_settings, _poolAdmin);
	}

	/**
	 * @notice Initializes pool simultaneously with its creation
	 * @param _settings - pool settings struct
	 */
	function __init_UFarmPool_unchained(
		CreationSettingsWithLinks memory _settings,
		address _poolAdmin
	) internal onlyInitializing {
		address _valueToken = _settings.params.valueToken;

		(ufarmFund, _ufarmCore, poolAdmin, valueToken) = (
			_settings.ufarmFund,
			_settings.ufarmCore,
			_poolAdmin,
			_valueToken
		);

		if (!ICoreWhitelist(_ufarmCore).isTokenWhitelisted(_valueToken))
			revert TokenIsNotAllowed(_valueToken);

		__decimals = ERC20(_valueToken).decimals();

		_changeStatus(PoolStatus.Created);
	}

	//// ASSET MANAGEMENT FUNCTIONS

	/**
	 *  @inheritdoc PoolWhitelist
	 */
	function isTokenAllowed(address token) public view override(PoolWhitelist) returns (bool) {
		return (token == valueToken) || super.isTokenAllowed(token);
	}

	//// MAIN FUNCTIONS
	function version() public pure override returns (string memory) {
		return '1.0';
	}

	function name() public view override(ECDSARecover, ERC20) returns (string memory) {
		return ERC20.name();
	}

	/**
	 * @inheritdoc ERC20
	 */
	function decimals() public view override(ERC20, IUFarmPool) returns (uint8) {
		return __decimals;
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function ufarmCore() public view override(IUFarmPool, PoolWhitelist) returns (address) {
		return _ufarmCore;
	}

	/**
	 * @notice Returns the current pool exchange rate
	 */
	function getExchangeRate() public view override returns (uint256 exchangeRate) {
		uint256 totalCost = getTotalCost();
		uint256 presicion = 10 ** decimals();

		IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();

		(
			uint256 protocolFee,
			uint256 managementFee,
			uint256 performanceFee,
			uint256 sharesToUFarm,
			uint256 sharesToFund
		) = _calculateFee(totalCost, config.managementCommission, config.packedPerformanceFee);

		return
			(totalCost == 0)
				? presicion
				: (totalCost * presicion) / (totalSupply() + sharesToUFarm + sharesToFund);
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function getTotalCost() public view override returns (uint256 totalCost) {
		return
			IPriceOracle(IUFarmCore(_ufarmCore).priceOracle()).getTotalCostOfPool(
				address(this),
				valueToken
			);
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function erc20CommonAssets() external view override returns (address[] memory tokenAssets) {
		return __assets.erc20CommonAssets();
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function erc20ControlledAssets()
		external
		view
		override
		returns (AssetsStructs.ControlledERC20[] memory liquidityAssetsERC20)
	{
		return __assets.erc20ControlledAssets();
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function erc721ControlledAssets()
		external
		view
		returns (/*override*/ AssetsStructs.ControlledERC721[] memory liquidityAssetsERC721)
	{
		return __assets.erc721ControlledAssets();
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function deposit(
		uint256 _amountToInvest
	)
		external
		override
		ufarmIsNotPaused
		nonZeroValue(_amountToInvest)
		nonReentrant
		returns (uint256 toMint)
	{
		_checkStatusForFinancing(true);
		IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();

		if (
			(msg.sender != ufarmFund) &&
			(_amountToInvest < config.minInvestment || _amountToInvest > config.maxInvestment)
		) revert InvalidInvestmentAmount(_amountToInvest, config.minInvestment, config.maxInvestment);

		uint256 totalAssetsCost = getTotalCost();
		_accrueFee(totalAssetsCost, config.managementCommission, config.packedPerformanceFee);

		IERC20(valueToken).safeTransferFrom(msg.sender, address(this), _amountToInvest);

		_addERC20(valueToken, bytes32(0));

		highWaterMark += _amountToInvest;

		toMint = _mintSharesByQuote(msg.sender, _amountToInvest, totalAssetsCost);

		emit Deposit(msg.sender, valueToken, _amountToInvest, toMint);
		// TODO: make optional hook in deposit to invoke something on controller, to restake, as example
	}

	/**
	 * @notice Validates deposit request and returns investor address, amount to invest and deposit request hash
	 * @param depositRequestuest - signed deposit request struct
	 * @return investor - investor address
	 * @return amountToInvest - amount to invest
	 * @return depositRequestHash - whole signed deposit request hash
	 */
	function validateDepositRequest(
		SignedDepositRequest memory depositRequestuest
	) public view returns (address investor, uint256 amountToInvest, bytes32 depositRequestHash) {
		depositRequestHash = ECDSARecover.toEIP712MessageHash(
			DOMAIN_SEPARATOR(),
			_hashDepositReqBody(depositRequestuest.body)
		);

		if (__usedDepositsRequests[depositRequestHash]) revert UFarmErrors.ActionAlreadyDone();

		investor = ECDSARecover.recoverAddress(depositRequestHash, depositRequestuest.signature);
		if (investor == address(0)) revert ECDSARecover.WrongSignature();

		if (block.timestamp > depositRequestuest.body.deadline)
			revert DeadlineExpired(depositRequestuest.body.deadline, block.timestamp);

		if (depositRequestuest.body.poolAddr != address(this))
			revert AnotherPoolExpected(address(this), depositRequestuest.body.poolAddr);

		amountToInvest = depositRequestuest.body.amountToInvest;

		if (amountToInvest == 0) revert InvalidInvestmentAmount(amountToInvest, 0, type(uint256).max);
	}

	/**
	 * @notice Validates withdrawal request and returns investor address, shares to burn and withdrawal request hash
	 * @param withdRequest - signed withdrawal request struct
	 * @return investor - investor address
	 * @return sharesToBurn - amount of shares to burn
	 * @return withdrawRequestHash - whole signed withdrawal request hash
	 */
	function validateWithdrawalRequest(
		SignedWithdrawalRequest memory withdRequest
	) public view returns (address investor, uint256 sharesToBurn, bytes32 withdrawRequestHash) {
		withdrawRequestHash = ECDSARecover.toEIP712MessageHash(
			DOMAIN_SEPARATOR(),
			_hashWithdrawReqBody(withdRequest.body)
		);

		if (__usedWithdrawalsRequests[withdrawRequestHash]) revert UFarmErrors.ActionAlreadyDone();

		investor = ECDSARecover.recoverAddress(withdrawRequestHash, withdRequest.signature);
		if (investor == address(0)) revert ECDSARecover.WrongSignature();

		if (withdRequest.body.poolAddr != address(this))
			revert AnotherPoolExpected(address(this), withdRequest.body.poolAddr);

		sharesToBurn = withdRequest.body.sharesToBurn;

		if (sharesToBurn > balanceOf(investor) || sharesToBurn == 0)
			revert InvalidWithdrawalAmount(sharesToBurn, balanceOf(investor));
	}

	function approveDeposits(
		SignedDepositRequest[] calldata _depositRequests
	) external ufarmIsNotPaused nonReentrant onlyFundMember {
		_checkStatusForFinancing(true);

		uint256 requestsLength = _depositRequests.length;
		_nonEmptyArray(requestsLength);

		IPoolAdmin _poolAdmin = IPoolAdmin(poolAdmin);

		_poolAdmin.checkPoolOrFundPermission(
			msg.sender,
			Permissions.Pool.ApprovePoolTopup,
			Permissions.Fund.ApprovePoolTopup
		);
		IPoolAdmin.PoolConfig memory config = _poolAdmin.getConfig();

		uint256 totalCost = getTotalCost();
		_accrueFee(totalCost, config.managementCommission, config.packedPerformanceFee);

		// solidity gas optimization
		address investor;
		uint256 sharesToMint;
		uint256 amountToInvest;
		bytes32 depositRequestHash;
		uint256 totalDeposit;

		for (uint256 i; i < requestsLength; ++i) {
			// Validate each deposit request
			(investor, amountToInvest, depositRequestHash) = validateDepositRequest(_depositRequests[i]);
			__usedDepositsRequests[depositRequestHash] = true;

			// Process the deposit
			IERC20(valueToken).safeTransferFrom(investor, address(this), amountToInvest);
			sharesToMint = _mintSharesByQuote(investor, amountToInvest, totalCost);

			// Adjust the total cost and total deposit
			totalCost += amountToInvest;
			totalDeposit += amountToInvest;

			emit Deposit(investor, valueToken, amountToInvest, sharesToMint);
			emit DepositRequestExecuted(investor, depositRequestHash);
		}

		_addERC20(valueToken, bytes32(0));
		highWaterMark += totalDeposit;
	}

	function approveWithdrawals(
		SignedWithdrawalRequest[] calldata _withdrawRequests
	) external ufarmIsNotPaused nonReentrant onlyFundMember {
		_checkStatusForFinancing(false);

		uint256 requestsLength = _withdrawRequests.length;
		_nonEmptyArray(requestsLength);

		IPoolAdmin _poolAdmin = IPoolAdmin(poolAdmin);

		_poolAdmin.checkPoolOrFundPermission(
			msg.sender,
			Permissions.Pool.ApprovePoolWithdrawals,
			Permissions.Fund.ApprovePoolWithdrawals
		);
		IPoolAdmin.PoolConfig memory config = _poolAdmin.getConfig();

		uint256 totalCost = getTotalCost();
		_accrueFee(totalCost, config.managementCommission, config.packedPerformanceFee);

		// solidity gas optimization
		address investor;
		uint256 sharesToBurn;
		uint256 amountToWithdraw;
		bytes32 withdrawalRequestHash;

		for (uint256 i; i < requestsLength; ++i) {
			// Validate each withdrawal request
			(investor, sharesToBurn, withdrawalRequestHash) = validateWithdrawalRequest(
				_withdrawRequests[i]
			);

			// Mark the request as used
			__usedWithdrawalsRequests[withdrawalRequestHash] = true;

			// Delete the request from the pending withdrawals
			delete pendingWithdrawalsRequests[withdrawalRequestHash];

			// Process the withdrawal
			amountToWithdraw = _processWithdrawal(
				investor,
				sharesToBurn,
				totalCost,
				withdrawalRequestHash
			);

			// Adjust the total cost
			totalCost -= amountToWithdraw;
		}
	}

	/**
	 * @inheritdoc IUFarmPool
	 */
	function withdraw(
		SignedWithdrawalRequest calldata _withdrawalRequest
	) external override ufarmIsNotPaused nonReentrant returns (uint256 burnedAssetsCost) {
		_checkStatusForFinancing(false);
		IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();
		uint256 totalAssetsCost = getTotalCost();
		_accrueFee(totalAssetsCost, config.managementCommission, config.packedPerformanceFee);

		if (msg.sender == ufarmFund) {
			// Check for the mandatory shares if pool is still active
			if (status < PoolStatus.Deactivating) {
				uint256 mandatoryShares = (IUFarmCore(_ufarmCore).minimumFundDeposit() * totalSupply()) /
					totalAssetsCost;
				uint256 totalUserShares = balanceOf(msg.sender);

				uint256 availableToWithdraw = totalUserShares > mandatoryShares
					? totalUserShares - mandatoryShares
					: 0;

				if (_withdrawalRequest.body.sharesToBurn > availableToWithdraw)
					revert InvalidWithdrawalAmount(_withdrawalRequest.body.sharesToBurn, availableToWithdraw);
			}
			return
				_processWithdrawal(
					msg.sender,
					_withdrawalRequest.body.sharesToBurn,
					totalAssetsCost,
					keccak256(abi.encode(blockhash(block.number), totalSupply())) // Pseudo-random hash
				);
		} else {
			// Check if the withdrawal request is valid
			(
				address investor,
				uint256 sharesToBurn,
				bytes32 withdrawalRequestHash
			) = validateWithdrawalRequest(_withdrawalRequest);

			if (config.withdrawalLockupPeriod > 0) {
				if (pendingWithdrawalsRequests[withdrawalRequestHash] == 0) {
					// Set the withdrawal request timestamp
					pendingWithdrawalsRequests[withdrawalRequestHash] = block.timestamp;
					emit WithdrawRequestReceived(investor, withdrawalRequestHash, block.timestamp);
					return 0;
				} else {
					// Check if the lockup period has passed
					uint256 unlockTime = pendingWithdrawalsRequests[withdrawalRequestHash] +
						config.withdrawalLockupPeriod;
					if (block.timestamp < unlockTime)
						// Safe because of the check above
						revert LockupPeriodNotPassed(unlockTime);
				}
			}

			// Mark the request as used
			__usedWithdrawalsRequests[withdrawalRequestHash] = true;

			// Delete the request from the pending withdrawals
			delete pendingWithdrawalsRequests[withdrawalRequestHash];

			return _processWithdrawal(investor, sharesToBurn, totalAssetsCost, withdrawalRequestHash);
		}
	}

	function _processWithdrawal(
		address investor,
		uint256 sharesToBurn,
		uint256 _totalcost,
		bytes32 withdrawalRequestHash
	) private keepWithdrawalHash(withdrawalRequestHash) returns (uint256 burnedAssetsCost) {
		uint256 _totalSupply = totalSupply();
		burnedAssetsCost = (_totalcost * sharesToBurn) / _totalSupply;

		_burn(investor, sharesToBurn);
		if (IERC20(valueToken).balanceOf(address(this)) > burnedAssetsCost) {
			IERC20(valueToken).safeTransfer(investor, burnedAssetsCost);
			_tryRemoveERC20(valueToken);
			emit Withdraw(investor, valueToken, burnedAssetsCost, withdrawalRequestHash);
		} else {
			address asset;
			uint256 length;

			// Avoiding stack too deep error
			{
				// ERC721 -> ERC20
				address controllerAddr;
				bytes32 controllerHash;
				bytes[] memory forceSellTxs;

				uint256[] memory ids;

				length = __assets.erc721Controlled.assets.length();
				for (uint256 i; i < length; ++i) {
					asset = __assets.erc721Controlled.assets.at(i);
					controllerHash = __assets.erc721Controlled.controllers[asset];
					controllerAddr = _getProtocolController(controllerHash);

					ids = __assets.erc721Controlled.idsOfAsset[asset].values();

					for (uint256 j; j < ids.length; ++j) {
						forceSellTxs = IERC721Controller(controllerAddr).encodePartialWithdrawalERC721(
							asset,
							ids[j],
							sharesToBurn,
							_totalSupply
						);

						for (uint256 k; k < forceSellTxs.length; ++k) {
							_protocolAction(true, controllerAddr, controllerHash, investor, forceSellTxs[k]);
						}
					}
				}

				// Synth ERC20 -> ERC20
				length = __assets.erc20Controlled.assets.length();
				for (uint256 i; i < length; ++i) {
					asset = __assets.erc20Controlled.assets.at(i);
					controllerHash = __assets.erc20Controlled.controllers[asset];
					controllerAddr = _getProtocolController(controllerHash);

					forceSellTxs = IERC20SynthController(controllerAddr).encodePartialWithdrawalERC20(
						asset,
						sharesToBurn,
						_totalSupply
					);

					for (uint256 j; j < forceSellTxs.length; ++j) {
						_protocolAction(true, controllerAddr, controllerHash, investor, forceSellTxs[j]);
					}
				}
			}

			// Common ERC20
			uint256 assetBalance;
			uint256 toWithdraw;
			address[] memory commonAssets = __assets.erc20CommonAssets();

			length = commonAssets.length;
			for (uint256 i; i < length; ++i) {
				asset = commonAssets[i];
				assetBalance = IERC20(asset).balanceOf(address(this));
				toWithdraw = (assetBalance * sharesToBurn) / _totalSupply;
				if (toWithdraw > 0) {
					IERC20(asset).safeTransfer(investor, toWithdraw);
					_tryRemoveERC20(asset);
					emit Withdraw(investor, asset, toWithdraw, withdrawalRequestHash);
				}
			}
		}

		highWaterMark -= highWaterMark > burnedAssetsCost ? burnedAssetsCost : highWaterMark;

		emit WithdrawRequestExecuted(investor, sharesToBurn, withdrawalRequestHash);

		return burnedAssetsCost;
	}

	/**
	 * @notice Allows to call any function of the protocol controller
	 * @param _protocol - protocol name
	 * @param _data - encoded function call of controller with selector and arguments
	 */
	function protocolAction(
		bytes32 _protocol,
		bytes calldata _data
	) external ufarmIsNotPaused onlyFundMember nonReentrant {
		_checkProtocolAllowance(_protocol);
		_statusBeforeOrThis(PoolStatus.Deactivating);
		IPoolAdmin(poolAdmin).isAbleToManageFunds(msg.sender);
		__isMangerAction = true;
		_protocolAction(false, _getProtocolController(_protocol), _protocol, address(this), _data);
		delete __isMangerAction;
	}

	/**
	 * @notice Changes pool status to `_newStatus`
	 * @dev Only the PoolAdmin contract can call this function
	 * @param _newStatus - new pool status
	 */
	function changeStatus(PoolStatus _newStatus) external override {
		if (msg.sender != poolAdmin) revert UFarmErrors.NonAuthorized();

		_changeStatus(_newStatus);
	}

	/**
	 * @dev Only for Controllers. Adds ERC20 asset to the pool assets list
	 */
	function addERC20(address _asset, bytes32 _controllerOrZero) external calledByController {
		_addERC20(_asset, _controllerOrZero);
	}

	/**
	 * @dev Only for Controllers. Removes ERC20 asset from the pool assets list
	 */
	function removeERC20(address _asset) external calledByController {
		_tryRemoveERC20(_asset);
	}

	function addERC721(address _asset, uint256[] memory _ids) external calledByController {
		_addERC721WithController(_asset, _ids, protocolInUse);
	}

	function removeERC721(address _asset, uint256[] memory _ids) external calledByController {
		_removeERC721WithController(_asset, _ids);
	}

	//// INTERNAL FUNCTIONS

	function _checkStatusForFinancing(bool isDeposit) private view {
		IUFarmFund.FundStatus fundStatus = IUFarmFund(ufarmFund).status();

		if (msg.sender == ufarmFund) {
			if (isDeposit) {
				// Fund can't deposit if it's not in Active or Approved status
				if (fundStatus > IUFarmFund.FundStatus.Active)
					revert IUFarmFund.WrongFundStatus(IUFarmFund.FundStatus.Active, fundStatus);
				// Fund can't deposit if pool is Terminated
				_statusBeforeOrThis(PoolStatus.Deactivating);
			} else {
				// Fund can't withdraw if it's Blocked
				if (fundStatus == IUFarmFund.FundStatus.Blocked) {
					revert IUFarmFund.WrongFundStatus(IUFarmFund.FundStatus.Terminated, fundStatus);
				}
			}
		} else {
			if (isDeposit) {
				// Investor can't deposit if fund isn't Active
				if (fundStatus != IUFarmFund.FundStatus.Active) {
					revert IUFarmFund.WrongFundStatus(IUFarmFund.FundStatus.Active, fundStatus);
				}
				// Investor can't deposit if pool isn't Active
				_statusIs(PoolStatus.Active);
			}
			// Investor can withdraw regardless of fund or pool status
		}
	}

	function _checkActiveFund() private view {
		IUFarmFund.FundStatus fundStatus = IUFarmFund(ufarmFund).status();
		if (fundStatus != IUFarmFund.FundStatus.Active) {
			revert IUFarmFund.WrongFundStatus(IUFarmFund.FundStatus.Active, fundStatus);
		}
	}

	function _isCallerFundMember() private view {
		if (
			!UFarmPermissionsModel(address(ufarmFund)).hasPermission(
				msg.sender,
				uint8(Permissions.Fund.Member)
			)
		) revert UFarmErrors.NonAuthorized();
	}

	/**
	 * @notice Reverts if the pool status is not equal to `_requiredStatus`
	 * @param _requiredStatus - required pool status
	 */
	function _statusIs(PoolStatus _requiredStatus) private view {
		if (status != _requiredStatus) revert InvalidPoolStatus(_requiredStatus, status);
	}

	/**
	 * @notice Reverts if the pool status is not equal to `_lastAllowedStatus` or any status before it
	 */
	function _statusBeforeOrThis(PoolStatus _lastAllowedStatus) private view {
		if (status > _lastAllowedStatus)
			revert InvalidPoolStatus(PoolStatus(_lastAllowedStatus), status);
	}

	function _protocolAction(
		bool _ignoreRevert,
		address _controllerAddr,
		bytes32 _protocolHash,
		address _target,
		bytes memory _data
	) private checkDelegateCall {
		protocolInUse = _protocolHash;
		_protocolTarget = _target;
		SafeOPS._safeDelegateCall(_ignoreRevert, _controllerAddr, _data);
		delete protocolInUse;
		delete _protocolTarget;

		emit SuccessfullControllerCall(_protocolHash);
	}

	/**
	 * @notice Returns controller address by its name
	 * @param _protocol - protocol name
	 * @return controllerAddr - controller address
	 */
	function _getProtocolController(bytes32 _protocol) private view returns (address controllerAddr) {
		controllerAddr = IUFarmCore(_ufarmCore).controllers(_protocol);
		if (controllerAddr == address(0)) revert FETCHING_CONTROLLER_FAILED();
	}

	/**
	 * @notice Reverts if the UFarm platform is paused
	 */
	function _ufarmIsNotPaused() private view {
		if (IUFarmCore(_ufarmCore).isPaused()) revert UFarmIsPaused();
	}

	/**
	 * @notice Accrues fees and mints corresponding pool shares.
	 * @param totalCost The total cost value of the pool.
	 * @param managementCommission The management commission rate.
	 * @param packedPerformanceCommission The performance commission rate.
	 */
	function _accrueFee(
		uint256 totalCost,
		uint256 managementCommission,
		uint256 packedPerformanceCommission
	) private {
		// When pool is created, lastAccrual is 0, so we need to set it to current timestamp
		// and set HWM to totalCost
		if (lastAccrual == 0) {
			lastAccrual = block.timestamp;
			highWaterMark = totalCost;
			return;
		}

		(
			uint256 protocolFee,
			uint256 managementFee,
			uint256 performanceFee,
			uint256 sharesToUFarm,
			uint256 sharesToFund
		) = _calculateFee(totalCost, managementCommission, packedPerformanceCommission);

		if (totalCost > highWaterMark) highWaterMark = totalCost;

		bool mintedToCore = _mintShares(_ufarmCore, sharesToUFarm);
		bool mintedToFund = _mintShares(ufarmFund, sharesToFund);

		if (mintedToCore || mintedToFund) lastAccrual = block.timestamp;

		emit FeeAccrued(protocolFee, managementFee, performanceFee, sharesToUFarm, sharesToFund);
	}

	function _calculateFee(
		uint256 totalCost,
		uint256 managementCommission,
		uint256 packedPerformanceCommission
	)
		private
		view
		returns (
			uint256 protocolFee,
			uint256 managementFee,
			uint256 performanceFee,
			uint256 sharesToUFarm,
			uint256 sharesToFund
		)
	{
		uint256 accrualTime = block.timestamp - lastAccrual;

		if (lastAccrual == 0 || accrualTime == 0) {
			return (0, 0, 0, 0, 0);
		}

		{
			uint256 protocolCommission = IUFarmCore(_ufarmCore).protocolCommission();
			uint256 costInTime = (totalCost * accrualTime) / YEAR;

			(protocolFee, managementFee) = (
				(costInTime * protocolCommission) / ONE,
				(costInTime * managementCommission) / ONE
			);
		}

		if (totalCost > highWaterMark) {
			uint256 profit = totalCost - highWaterMark;

			performanceFee = (profit * PerformanceFeeLib.ONE_HUNDRED_PERCENT) / highWaterMark; // APY ratio
			uint16 performanceCommission = performanceFee > PerformanceFeeLib.MAX_COMMISSION_STEP
				? PerformanceFeeLib.MAX_COMMISSION_STEP
				: uint16(performanceFee); // Compare with max commission step, normalizing to MAX_COMMISSION_STEP

			performanceCommission = PerformanceFeeLib._getPerformanceCommission(
				packedPerformanceCommission,
				performanceCommission
			); // Unpack commission percent for the step, where step is APY multiplier

			performanceFee = (profit * performanceCommission) / PerformanceFeeLib.ONE_HUNDRED_PERCENT; // Profit * commission rate
		}
		uint256 totalFundFee = (4 * (performanceFee + managementFee)) / 5; // 80%
		uint256 totalUFarmFee = totalFundFee / 4 + protocolFee; // 20% + protocol fee

		uint256 _totalSupply = totalSupply();

		sharesToUFarm = _sharesByQuote(totalUFarmFee, _totalSupply, totalCost);
		sharesToFund = _sharesByQuote(totalFundFee, _totalSupply + sharesToUFarm, totalCost);
	}

	/**
	 * @notice Calculates the number of shares equivalent to the the value amount and mints them to the fee recipient.
	 * @param to The address to mint the fee shares to.
	 * @param quoteAmount The total amount in value token.
	 * @param totalCost The total cost value of the pool.
	 * @return sharesMinted The number of shares minted.
	 */
	function _mintSharesByQuote(
		address to,
		uint256 quoteAmount,
		uint256 totalCost
	) internal returns (uint256 sharesMinted) {
		uint256 _totalSupply = totalSupply();
		sharesMinted = _sharesByQuote(quoteAmount, _totalSupply, totalCost);
		_mintShares(to, sharesMinted);
	}

	function _sharesByQuote(
		uint256 quoteAmount,
		uint256 _totalSupply,
		uint256 totalCost
	) internal pure returns (uint256 shares) {
		shares = (totalCost > 0 && _totalSupply > 0)
			? ((quoteAmount * _totalSupply) / totalCost)
			: quoteAmount;
	}

	function _mintShares(address to, uint256 sharesToMint) internal returns (bool success) {
		if (sharesToMint == 0) return false;
		_mint(to, sharesToMint);
		return true;
	}

	function _hashDepositReqBody(
		DepositRequest memory depositRequestuest
	) private pure returns (bytes32) {
		return
			keccak256(
				abi.encode(
					keccak256(
						'DepositRequest(uint256 amountToInvest,bytes32 salt,address poolAddr,uint96 deadline)'
					),
					depositRequestuest.amountToInvest,
					depositRequestuest.salt,
					depositRequestuest.poolAddr,
					depositRequestuest.deadline
				)
			);
	}

	function _hashWithdrawReqBody(
		WithdrawRequest memory withdrawRequest
	) private pure returns (bytes32) {
		return
			keccak256(
				abi.encode(
					keccak256('WithdrawRequest(uint256 sharesToBurn,bytes32 salt,address poolAddr)'),
					withdrawRequest.sharesToBurn,
					withdrawRequest.salt,
					withdrawRequest.poolAddr
				)
			);
	}

	function _changeStatus(PoolStatus _newStatus) private {
		status = _newStatus;
		emit PoolStatusChanged(_newStatus);
	}

	function _addERC20(address _asset, bytes32 _controllerAddr) private {
		// Do not add pure ERC20 token if it is not whitelisted
		if (_controllerAddr == bytes32(0) && !isTokenAllowed(_asset)) return;

		__assets.addERC20(_asset, _controllerAddr);
		_checkMaxAssetWeight();
	}

	function _tryRemoveERC20(address _asset) private {
		__assets.removeERC20(_asset);
	}

	function _addERC721WithController(
		address _asset,
		uint256[] memory _ids,
		bytes32 _controller
	) private {
		__assets.addERC721WithController(_asset, _ids, _controller);
		_checkMaxAssetWeight();
	}

	function _removeERC721WithController(address _asset, uint256[] memory _ids) private {
		__assets.removeERC721WithController(_asset, _ids);
	}

	function _checkMaxAssetWeight() private view {
		if (__isMangerAction && __assets.totalWeight > MAX_TOKEN_WEIGHT) {
			revert AssetsWeightAboveMax(__assets.totalWeight);
		}
	}

	uint256[50] private __gap;
}
