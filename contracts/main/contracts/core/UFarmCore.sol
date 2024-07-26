// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// INTERFACES
import {IUFarmCore} from './IUFarmCore.sol';
import {IUFarmFund} from '../fund/IUFarmFund.sol';
import {IFundFactory} from '../fund/FundFactory.sol';
import {IPoolFactory} from '../pool/PoolFactory.sol';
import {IUFarmCoreLink} from '../../shared/UFarmCoreLink.sol';
import {Permissions} from '../permissions/Permissions.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// CONTRACTS
import {CoreWhitelist, ICoreWhitelist} from './CoreWhitelist.sol';
import {UFarmPermissionsModel} from '../permissions/UFarmPermissionsModel.sol';
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import {UFarmOwnableUUPS} from '../../shared/UFarmOwnableUUPS.sol';

/// LIBRARIES
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';

/**
 * @title UFarmCore
 * @author https://ufarm.digital/
 * @notice UFarmCore is the core contract of the UFarm protocol.
 * Keeps track of all funds, assets, UFarm permissions, and fees.
 */
contract UFarmCore is
	IUFarmCore,
	CoreWhitelist,
	UFarmPermissionsModel,
	ReentrancyGuard,
	UFarmOwnableUUPS
{
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.AddressSet;

	/**
	 * @inheritdoc IUFarmCore
	 */
	uint256 public protocolCommission;

	/**
	 * @inheritdoc IUFarmCore
	 */
	uint256 public minimumFundDeposit;

	/**
	 * @inheritdoc IUFarmCore
	 */
	IFundFactory public fundFactory;

	/**
	 * @inheritdoc IUFarmCore
	 */
	IPoolFactory public poolFactory;

	/**
	 * @inheritdoc IUFarmCore
	 */
	address public priceOracle;

	/**
	 * @inheritdoc IUFarmCore
	 */
	bool public isPaused;

	EnumerableSet.AddressSet private _funds;

	/// EVENTS
	/**
	 * @notice Emitted when new fund is created
	 * @param applicationId - internal DB application id
	 * @param fundId - fund id
	 * @param fund - fund address
	 */
	event FundCreated(bytes32 indexed applicationId, uint256 fundId, address fund);
	/**
	 * @notice Emitted when minimum fund deposit is changed
	 * @param minimumFundDeposit - new minimum fund deposit
	 */
	event MinimumFundDepositChanged(uint256 minimumFundDeposit);
	/**
	 * @notice Emitted when protocol commission is changed
	 * @param protocolCommission - new protocol commission
	 */
	event ProtocolCommissionChanged(uint256 protocolCommission);
	/**
	 * @notice Emitted when pause action is performed
	 * @param isPaused - new pause status: `true` if paused, `false` if unpaused
	 */
	event PauseAction(bool isPaused);

	/// MODIFIERS
	/**
	 * @notice Reverts if the caller doesn't have two permissions or is not the owner
	 * @param permission1 - first permission (often membership)
	 * @param permission2 - second permission (often some kind of editor)
	 */
	modifier ownerOrHaveTwoPermissions(uint8 permission1, uint8 permission2) {
		if (!_hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
			_checkForPermissions(msg.sender, _twoPermissionsToMask(permission1, permission2));
		}
		_;
	}

	function __init__UFarmCore(
		address _admin,
		address _fundFactory,
		address _poolFactory,
		address _priceOracle
	)
		external
		onlyDeployer
		nonZeroAddress(_admin)
		nonZeroAddress(_fundFactory)
		nonZeroAddress(_poolFactory)
		nonZeroAddress(_priceOracle)
		initializer
	{
		__init__UFarmOwnableUUPS();
		__init__UFarmCore_unchained(_admin, _fundFactory, _poolFactory, _priceOracle);
	}

	function __init__UFarmCore_unchained(
		address _admin,
		address _fundFactory,
		address _poolFactory,
		address _priceOracle
	) internal onlyInitializing {
		priceOracle = _priceOracle;
		IUFarmCoreLink(_priceOracle).coreCallback();

		fundFactory = IFundFactory(_fundFactory);
		IUFarmCoreLink(_fundFactory).coreCallback();

		poolFactory = IPoolFactory(_poolFactory);
		IUFarmCoreLink(_poolFactory).coreCallback();

		_updatePermissions(_admin, _FULL_PERMISSIONS_MASK);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function getFund(uint256 fundId) external view returns (address) {
		return _funds.at(fundId);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function fundsCount() external view returns (uint256) {
		return _funds.length();
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function isFund(address _fund) external view returns (bool) {
		return _funds.contains(_fund);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function createFund(
		address _fundManager,
		bytes32 _applicationId
	)
		external
		override
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ApproveFundCreation)
		)
		nonReentrant
		returns (address fund)
	{
		uint256 nextFundId = _funds.length();

		fund = fundFactory.createFund(_fundManager, _applicationId);

		_funds.add(fund);

		emit FundCreated(_applicationId, nextFundId, fund);
	}

	/**
	 * @notice Allows managers to use this tokens
	 * @param _tokens - array of tokens with PriceFeeds to whitelist
	 */
	function whitelistTokens(
		AssetWithPriceFeed[] calldata _tokens
	)
		external
		override
		nonReentrant
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageWhitelist)
		)
	{
		_whitelistTokens(_tokens);
	}

	/**
	 * @notice Disallows managers to use this tokens
	 * @param _tokens - array of token addresses to blacklist
	 */
	function blacklistTokens(
		address[] calldata _tokens
	)
		external
		override
		nonReentrant
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageWhitelist)
		)
	{
		_blacklistTokens(_tokens);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function setMinimumFundDeposit(
		uint256 _minimumFundDeposit
	)
		external
		override
		nonSameValue(_minimumFundDeposit, minimumFundDeposit)
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageFundDeposit)
		)
	{
		if (minimumFundDeposit != _minimumFundDeposit) {
			minimumFundDeposit = _minimumFundDeposit;
			emit MinimumFundDepositChanged(_minimumFundDeposit);
		} else revert ActionAlreadyDone();
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function setProtocolCommission(
		uint256 _protocolCommission
	)
		external
		override
		valueInRange(_protocolCommission, 0, 1e17)
		ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageFees))
	{
		if (protocolCommission != _protocolCommission) {
			protocolCommission = _protocolCommission;
			emit ProtocolCommissionChanged(_protocolCommission);
		} else revert ActionAlreadyDone();
	}

	/**
	 * @notice Allows managers to use this protocols
	 * @param _protocolNames - array of protocols to whitelist [keccak256(protocolName)]
	 * @param _protocolControllers - array of controllers for protocols [controllerAddress]
	 */
	function whitelistProtocolsWithControllers(
		bytes32[] memory _protocolNames,
		address[] memory _protocolControllers
	)
		public
		override(CoreWhitelist, ICoreWhitelist)
		nonReentrant
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageWhitelist)
		)
	{
		super.whitelistProtocolsWithControllers(_protocolNames, _protocolControllers);
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function updateProtocolsControllers(
		bytes32[] memory _protocolNames,
		address[] memory _protocolControllers
	)
		public
		override(CoreWhitelist, ICoreWhitelist)
		nonReentrant
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageWhitelist)
		)
	{
		super.updateProtocolsControllers(_protocolNames, _protocolControllers);
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function blacklistProtocols(
		bytes32[] memory _protocols
	)
		public
		override(CoreWhitelist, ICoreWhitelist)
		nonReentrant
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageWhitelist)
		)
	{
		super.blacklistProtocols(_protocols);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function updatePermissions(address _user, uint256 _newPermissionsMask) external override {
		uint256 currentMask = _accountMask[_user];

		// if update owner permissions
		if (_isPermissionDiff(uint8(Permissions.UFarm.Owner), currentMask, _newPermissionsMask)) {
			// only owner can grant or revoke owner permissions
			_checkForPermissions(msg.sender, _permissionToMask(uint8(Permissions.UFarm.Owner))); // reverts if caller is not owner
			// owner cant update his own permissions
			if (msg.sender == _user) revert NonAuthorized();
		}
		// skip if msg.sender is owner
		else if (!_hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
			bool isMember = _maskHasPermission(_newPermissionsMask, uint8(Permissions.UFarm.Member));

			// if membership status changes
			if (_isPermissionDiff(uint8(Permissions.UFarm.Member), currentMask, _newPermissionsMask)) {
				_checkForPermissions(
					msg.sender,
					_twoPermissionsToMask(
						uint8(Permissions.UFarm.Member),
						isMember
							? uint8(Permissions.UFarm.DeleteUFarmMember) // if was member
							: uint8(Permissions.UFarm.UpdateUFarmMember) // else will be member
					)
				);
			}

			// shift left new bitmask for 2 bits, leaving only permissions (not Owner and Member roles)
			if ((_newPermissionsMask << 2) > 0) {
				_checkForPermissions(
					msg.sender,
					_twoPermissionsToMask(
						uint8(Permissions.UFarm.Member),
						uint8(Permissions.UFarm.UpdatePermissions)
					)
				);
			}
		}

		// checks for `already done` action
		_updatePermissions(_user, _newPermissionsMask);
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function withdrawAssets(
		address[] calldata _tokens,
		uint256[] calldata _amounts
	)
		external
		ownerOrHaveTwoPermissions(
			uint8(Permissions.UFarm.Member),
			uint8(Permissions.UFarm.ManageAssets)
		)
		nonReentrant
	{
		uint256 tokensLength = _tokens.length;
		if (tokensLength != _amounts.length) revert ArraysLengthMismatch();
		for (uint256 i; i < tokensLength; ++i) {
			IERC20(_tokens[i]).safeTransfer(msg.sender, _amounts[i]);
		}
	}

	/**
	 * @inheritdoc IUFarmCore
	 */
	function switchPause() external override {
		if (!_hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
			//  if user becomes member caller should have special permission
			_checkForPermissions(
				msg.sender,
				_twoPermissionsToMask(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.TurnPauseOn))
			);
		}
		isPaused = !isPaused;
		emit PauseAction(isPaused);
	}

	uint256[50] private __gap;
}
