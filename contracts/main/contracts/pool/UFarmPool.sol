// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/// INTERFACES
import {ICoreWhitelist} from "../core/CoreWhitelist.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUFarmCore} from "../core/IUFarmCore.sol";
import {IUFarmFund} from "../fund/IUFarmFund.sol";
import {IUFarmPool} from "./IUFarmPool.sol";
import {IPoolAdmin} from "./IPoolAdmin.sol";
import {Permissions} from "../permissions/Permissions.sol";
import {IQuexOracle} from "../oracle/IQuexOracle.sol";
import {IQuexOracleReceiver} from "../oracle/IQuexOracleReceiver.sol";

/// CONTRACTS
import {ECDSARecover} from "../../shared/ECDSARecover.sol";
import {ERC20Upgradeable as ERC20} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC721HolderUpgradeable as ERC721Holder} from "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import {NZGuard} from "../../shared/NZGuard.sol";
import {PoolWhitelist} from "./PoolWhitelist.sol";
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {UFarmErrors} from "../../shared/UFarmErrors.sol";
import {UFarmOwnableUUPSBeacon} from "../../shared/UFarmOwnableUUPSBeacon.sol";
import {UFarmPermissionsModel} from "../permissions/UFarmPermissionsModel.sol";

/// LIBRARIES
import {AssetsStructs} from "../../shared/AssetController.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {PerformanceFeeLib} from "./PerformanceFeeLib.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeOPS} from "../../shared/SafeOPS.sol";
import {DataItem} from "../oracle/IV1RequestRegistry.sol";

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

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
    UFarmOwnableUUPSBeacon,
    IQuexOracleReceiver,
    IERC1271
{
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    uint256 private constant HALF = 5e17;
    uint256 private constant ONE = 1e18;
    uint256 private constant TEN_PERCENTS = 1e17;
    uint256 private constant YEAR = 365 days;
    uint256 private constant QUEUE_LIMIT = 10;
    bytes32 private constant CLIENT_VERIFICATION_TYPEHASH =
        keccak256("ClientVerification(address investor,uint8 tier,uint128 validTill)");

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
    /// @custom:oz-renamed-from __assets
    AssetsStructs.Assets private __unusedAssets;

    uint8 private __decimals;
    bool private __isMangerAction;

    uint256 private _totalCost;

    uint256 private requestId;
    uint256 public quexFlowId;

    QueueItem[] private depositQueue;
    QueueItem[] private withdrawQueue;

    uint256 public quexFlowVersion;

    bool internal _useArbitraryController;

    /**
     * @notice Required minimum Client's verification level
     * @dev Possible values:
     * - 0: Unverified (Not verified)
     * - 10: Screened (Basic checks completed, KYT)
     * - 20: BasicKYC (Basic Know Your Customer checks completed)
     * - 30: EnhancedKYC (Enhanced Know Your Customer checks completed)
     * - 40: Accredited (Accredited Investor status)
     * - 50: Qualified (Qualified Purchaser status)
     * - 60: Institutional (Institutional Investor status)
     */
    uint8 public minClientTier;

    bytes32 internal unprocessedWithdraw;

    modifier keepWithdrawalHash(bytes32 _withdHash) {
        _withdrawalHash = _withdHash;
        _;
        delete _withdrawalHash;
    }

    modifier onlyUFarmCore() {
        require(msg.sender == _ufarmCore, "Caller is not UFarmCore");
        _;
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

        if (!ICoreWhitelist(_ufarmCore).isTokenWhitelisted(_valueToken)) revert TokenIsNotAllowed(_valueToken);

        __decimals = ERC20(_valueToken).decimals();
        minClientTier = 5;
        emit ClientTierRequirementUpdated(minClientTier);

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
        return "1.0";
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
    function getExchangeRate(uint256 __totalCost) public view override returns (uint256 exchangeRate) {
        uint256 presicion = 10 ** decimals();

        IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();

        (
            uint256 protocolFee,
            uint256 managementFee,
            uint256 performanceFee,
            uint256 sharesToUFarm,
            uint256 sharesToFund
        ) = _calculateFee(__totalCost, config.managementCommission, config.packedPerformanceFee);

        uint256 _totalSupply = totalSupply();
        return
            (_totalSupply == 0) ? presicion : (__totalCost * presicion) / (_totalSupply + sharesToUFarm + sharesToFund);
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function getTotalCost() public view override returns (uint256 totalCost) {
        return _totalCost;
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function getUnprocessedWithdraw() external view returns (bytes32 hash) {
        return unprocessedWithdraw;
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function deposit(
        uint256 _amountToInvest,
        ClientVerification calldata clientVerification
    ) external override ufarmIsNotPaused nonZeroValue(_amountToInvest) nonReentrant {
        _depositForToken(_amountToInvest, clientVerification, valueToken);
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function depositForToken(
        uint256 _amountToInvest,
        ClientVerification calldata clientVerification,
        address bearerToken
    ) public override ufarmIsNotPaused nonZeroValue(_amountToInvest) nonReentrant {
        if (!ICoreWhitelist(_ufarmCore).isValueTokenWhitelisted(bearerToken)) revert TokenIsNotAllowed(bearerToken);

        _depositForToken(_amountToInvest, clientVerification, bearerToken);
    }

    /**
     * @notice Internal implementation for deposit functionality
     * @param _amountToInvest Amount of investment tokens to invest
     * @param clientVerification Verification information for the owner of the deposit
     * @param bearerToken Address of the token to be used for investment
     */
    function _depositForToken(
        uint256 _amountToInvest,
        ClientVerification calldata clientVerification,
        address bearerToken
    ) private {
        _checkStatusForFinancing(true);
        _ensureActionDelayPassed();
        IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();

        if (depositQueue.length >= QUEUE_LIMIT) revert QueueIsFull();

        if (
            (msg.sender != ufarmFund) &&
            (_amountToInvest < config.minInvestment || _amountToInvest > config.maxInvestment)
        ) revert InvalidInvestmentAmount(_amountToInvest, config.minInvestment, config.maxInvestment);

        if (IERC20(bearerToken).balanceOf(msg.sender) < _amountToInvest) {
            revert InvalidInvestmentAmount(_amountToInvest, config.minInvestment, config.maxInvestment);
        }

        if (msg.sender != ufarmFund && minClientTier > 0) {
            require(minClientTier <= clientVerification.tier, "Tier too low");
            require(block.timestamp <= clientVerification.validTill, "Signature expired");

            bytes32 structHash = keccak256(
                abi.encode(
                    CLIENT_VERIFICATION_TYPEHASH,
                    msg.sender,
                    clientVerification.tier,
                    clientVerification.validTill
                )
            );
            bytes32 diHash = ECDSARecover.toEIP712MessageHash(
                DOMAIN_SEPARATOR(),
                structHash
            );
            address verifier = ECDSARecover.recoverAddress(diHash, clientVerification.signature);
            UFarmPermissionsModel(_ufarmCore).checkForPermissionsMask(
                verifier,
                UFarmPermissionsModel(_ufarmCore).twoPermissionsToMask(
                    uint8(Permissions.UFarm.Member),
                    uint8(Permissions.UFarm.VerifyClient)
                )
            );
        }

        depositQueue.push(QueueItem(_amountToInvest, 0, bytes32(0), msg.sender, bearerToken));
        sendQuexRequest();
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
    )
        public
        view
        returns (
            address investor,
            uint256 amountToInvest,
            bytes32 depositRequestHash,
            address bearerToken,
            uint256 minOutputAmount
        )
    {
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

        bearerToken = depositRequestuest.body.bearerToken;
        if (!ICoreWhitelist(_ufarmCore).isValueTokenWhitelisted(bearerToken)) revert TokenIsNotAllowed(bearerToken);

        amountToInvest = depositRequestuest.body.amountToInvest;
        minOutputAmount = depositRequestuest.body.minOutputAmount;

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
    )
        public
        view
        returns (address investor, uint256 sharesToBurn, bytes32 withdrawRequestHash, uint256 minOutputAmount)
    {
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
        minOutputAmount = withdRequest.body.minOutputAmount;

        if (sharesToBurn > balanceOf(investor) || sharesToBurn == 0)
            revert InvalidWithdrawalAmount(sharesToBurn, balanceOf(investor));
    }

    function approveDeposits(
        SignedDepositRequest[] calldata _depositRequests
    ) external ufarmIsNotPaused nonReentrant onlyFundMember {
        _checkStatusForFinancing(true);
        _ensureActionDelayPassed();

        uint256 requestsLength = _depositRequests.length;
        _nonEmptyArray(requestsLength);

        IPoolAdmin _poolAdmin = IPoolAdmin(poolAdmin);

        _poolAdmin.checkPoolOrFundPermission(
            msg.sender,
            Permissions.Pool.ApprovePoolTopup,
            Permissions.Fund.ApprovePoolTopup
        );

        for (uint256 i; i < requestsLength; ++i) {
            if (depositQueue.length >= QUEUE_LIMIT) break;

            try this.validateDepositRequest(_depositRequests[i]) returns (
                address investor,
                uint256 amountToInvest,
                bytes32 depositRequestHash,
                address bearerToken,
                uint256 minOutputAmount
            ) {
                depositQueue.push(
                    QueueItem(amountToInvest, minOutputAmount, depositRequestHash, investor, bearerToken)
                );
            } catch {
                continue;
            }
        }
        sendQuexRequest();
    }

    function approveWithdrawals(
        SignedWithdrawalRequest[] calldata _withdrawRequests
    ) external ufarmIsNotPaused nonReentrant onlyFundMember {
        _approveWithdrawalsForToken(_withdrawRequests, valueToken);
    }

    function approveWithdrawalsForToken(
        SignedWithdrawalRequest[] calldata _withdrawRequests,
        address bearerToken
    ) public ufarmIsNotPaused nonReentrant onlyFundMember {
        if (!ICoreWhitelist(_ufarmCore).isValueTokenWhitelisted(bearerToken)) revert TokenIsNotAllowed(bearerToken);

        _approveWithdrawalsForToken(_withdrawRequests, bearerToken);
    }

    function _approveWithdrawalsForToken(
        SignedWithdrawalRequest[] calldata _withdrawRequests,
        address bearerToken
    ) private {
        _checkStatusForFinancing(false);
        _ensureActionDelayPassed();

        uint256 requestsLength = _withdrawRequests.length;
        _nonEmptyArray(requestsLength);

        IPoolAdmin _poolAdmin = IPoolAdmin(poolAdmin);

        _poolAdmin.checkPoolOrFundPermission(
            msg.sender,
            Permissions.Pool.ApprovePoolWithdrawals,
            Permissions.Fund.ApprovePoolWithdrawals
        );

        for (uint256 i; i < requestsLength; ++i) {
            if (withdrawQueue.length >= QUEUE_LIMIT) break;

            try this.validateWithdrawalRequest(_withdrawRequests[i]) returns (
                address investor,
                uint256 sharesToBurn,
                bytes32 withdrawalRequestHash,
                uint256 minOutputAmount
            ) {
                withdrawQueue.push(
                    QueueItem(sharesToBurn, minOutputAmount, withdrawalRequestHash, investor, bearerToken)
                );
            } catch {
                continue;
            }
        }
        sendQuexRequest();
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function withdrawByFund(
        SignedWithdrawalRequest calldata _withdrawalRequest,
        address _bearerToken
    ) external override ufarmIsNotPaused nonReentrant {
        _checkStatusForFinancing(false);
        _ensureActionDelayPassed();

        if (withdrawQueue.length >= QUEUE_LIMIT) revert QueueIsFull();

        if (!ICoreWhitelist(_ufarmCore).isValueTokenWhitelisted(_bearerToken)) revert TokenIsNotAllowed(_bearerToken);

        if (msg.sender == ufarmFund) {
            withdrawQueue.push(
                QueueItem(
                    _withdrawalRequest.body.sharesToBurn,
                    _withdrawalRequest.body.minOutputAmount,
                    keccak256(abi.encode(blockhash(block.number), totalSupply())),
                    msg.sender,
                    _bearerToken
                )
            );
        } else {
            revert ActionProhibited();
        }

        sendQuexRequest();
    }

    /**
     * @inheritdoc IUFarmPool
     */
    function withdraw(
        SignedWithdrawalRequest calldata _withdrawalRequest
    ) external override ufarmIsNotPaused nonReentrant {
        _checkStatusForFinancing(false);
        _ensureActionDelayPassed();
        IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();

        if (withdrawQueue.length >= QUEUE_LIMIT) revert QueueIsFull();

        if (msg.sender == ufarmFund) {
            withdrawQueue.push(
                QueueItem(
                    _withdrawalRequest.body.sharesToBurn,
                    _withdrawalRequest.body.minOutputAmount,
                    keccak256(abi.encode(blockhash(block.number), totalSupply())),
                    msg.sender,
                    valueToken
                )
            );
        } else {
            uint256 sharesToBurn;
            address investor;
            bytes32 withdrawalRequestHash;
            uint256 minOutputAmount;
            (investor, sharesToBurn, withdrawalRequestHash, minOutputAmount) = validateWithdrawalRequest(
                _withdrawalRequest
            );

            if (config.withdrawalLockupPeriod > 0) {
                if (pendingWithdrawalsRequests[withdrawalRequestHash] == 0) {
                    // Set the withdrawal request timestamp
                    pendingWithdrawalsRequests[withdrawalRequestHash] = block.timestamp;
                    emit WithdrawRequestReceived(investor, withdrawalRequestHash, block.timestamp);
                } else {
                    // Check if the lockup period has passed
                    uint256 unlockTime = pendingWithdrawalsRequests[withdrawalRequestHash] +
                        config.withdrawalLockupPeriod;
                    if (block.timestamp < unlockTime) {
                        // Safe because of the check above
                        revert LockupPeriodNotPassed(unlockTime);
                    } else if (status >= PoolStatus.Deactivating) {
                        withdrawQueue.push(
                            QueueItem(sharesToBurn, minOutputAmount, withdrawalRequestHash, investor, valueToken)
                        );
                        sendQuexRequest();
                    } else {
                        if (unprocessedWithdraw == bytes32(0)) {
                            unprocessedWithdraw = withdrawalRequestHash;
                        }
                        _changeStatus(PoolStatus.Deactivating);
                    }
                }
                return;
            }

            withdrawQueue.push(QueueItem(sharesToBurn, minOutputAmount, withdrawalRequestHash, investor, valueToken));
        }

        sendQuexRequest();
    }

    /**
     * @notice External safeTransfer
     */
    function safeTransferFromPool(address investor, uint256 amountToWithdraw, address bearerToken) external {
        if (address(this) != msg.sender) revert UFarmErrors.NonAuthorized();
        IERC20(bearerToken).safeTransfer(investor, amountToWithdraw);
    }

    function _processWithdrawal(
        address investor,
        uint256 sharesToBurn,
        uint256 _totalcost,
        bytes32 withdrawalRequestHash,
        address bearerToken,
        uint256 minOutputAmount
    ) private keepWithdrawalHash(withdrawalRequestHash) returns (uint256 burnedAssetsCost, bool fundFail) {
        uint256 _totalSupply = totalSupply();
        burnedAssetsCost = (_totalcost * sharesToBurn) / _totalSupply;
        fundFail = false;

        if (burnedAssetsCost < minOutputAmount) {
            burnedAssetsCost = 0;
            emit WithdrawRequestExecuted(investor, 0, withdrawalRequestHash);
        } else if (IERC20(bearerToken).balanceOf(address(this)) >= burnedAssetsCost) {
            try this.safeTransferFromPool(investor, burnedAssetsCost, bearerToken) {
                _burn(investor, sharesToBurn);
                highWaterMark -= highWaterMark > burnedAssetsCost ? burnedAssetsCost : highWaterMark;
                emit Withdraw(investor, bearerToken, burnedAssetsCost, withdrawalRequestHash);
                emit WithdrawRequestExecuted(investor, sharesToBurn, withdrawalRequestHash);
            } catch {
                burnedAssetsCost = 0;
                emit WithdrawRequestExecuted(investor, 0, withdrawalRequestHash);
            }
        } else {
            burnedAssetsCost = 0;
            fundFail = true;
        }

        return (burnedAssetsCost, fundFail);
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
     * @notice Resets the oracle request id in case of errors
     */
    function resetOracleRequestId() external ufarmIsNotPaused onlyFundMember {
        IPoolAdmin(poolAdmin).isAbleToManageFunds(msg.sender);
        requestId = 0;
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
        if (!UFarmPermissionsModel(address(ufarmFund)).hasPermission(msg.sender, uint8(Permissions.Fund.Member)))
            revert UFarmErrors.NonAuthorized();
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
        if (status > _lastAllowedStatus) revert InvalidPoolStatus(PoolStatus(_lastAllowedStatus), status);
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
        actionDelayExpiration = block.timestamp + IUFarmCore(_ufarmCore).postActionDelay();

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

    function _ensureActionDelayPassed() private view {
        uint256 delayExpiration = actionDelayExpiration;

        if (block.timestamp < delayExpiration) revert ActionDelayNotPassed(delayExpiration);
    }

    /**
     * @notice Accrues fees and mints corresponding pool shares.
     * @param totalCost The total cost value of the pool.
     * @param managementCommission The management commission rate.
     * @param packedPerformanceCommission The performance commission rate.
     */
    function _accrueFee(uint256 totalCost, uint256 managementCommission, uint256 packedPerformanceCommission) private {
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

        if (totalCost - protocolFee - managementFee > highWaterMark) {
            uint256 profit = totalCost - protocolFee - managementFee - highWaterMark;

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

    function _sharesByQuote(
        uint256 quoteAmount,
        uint256 _totalSupply,
        uint256 totalCost
    ) internal pure returns (uint256 shares) {
        shares = (totalCost > 0 && _totalSupply > 0) ? ((quoteAmount * _totalSupply) / totalCost) : quoteAmount;
    }

    function _mintShares(address to, uint256 sharesToMint) internal returns (bool success) {
        if (sharesToMint == 0) return false;
        _mint(to, sharesToMint);
        return true;
    }

    function _hashDepositReqBody(DepositRequest memory depositRequestuest) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "DepositRequest(uint256 amountToInvest,bytes32 salt,address poolAddr,uint96 deadline,address bearerToken,uint256 minOutputAmount)"
                    ),
                    depositRequestuest.amountToInvest,
                    depositRequestuest.salt,
                    depositRequestuest.poolAddr,
                    depositRequestuest.deadline,
                    depositRequestuest.bearerToken,
                    depositRequestuest.minOutputAmount
                )
            );
    }

    function _hashWithdrawReqBody(WithdrawRequest memory withdrawRequest) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "WithdrawRequest(uint256 sharesToBurn,bytes32 salt,address poolAddr,uint256 minOutputAmount)"
                    ),
                    withdrawRequest.sharesToBurn,
                    withdrawRequest.salt,
                    withdrawRequest.poolAddr,
                    withdrawRequest.minOutputAmount
                )
            );
    }

    function _changeStatus(PoolStatus _newStatus) private {
        status = _newStatus;
        emit PoolStatusChanged(_newStatus);
    }

    /**
     * @notice Sends quex request if not awaiting for one
     */
    function sendQuexRequest() private {
        if (requestId == 0) {
            IQuexOracle quexOracle = IQuexOracle(IUFarmCore(_ufarmCore).priceOracle());

            if (quexFlowVersion != quexOracle.quexFlowVersion()) {
                (quexFlowId, quexFlowVersion) = quexOracle.createFlow();
                emit QuexFlowUpdated(quexFlowVersion, quexFlowId);
            }

            requestId = quexOracle.quexRequest(quexFlowId);
        }
    }

    /**
     * @notice External safeTransferFrom
     */
    function safeTransferToPool(address investor, uint256 amountToInvest, address bearerToken) external {
        if (address(this) != msg.sender) revert UFarmErrors.NonAuthorized();
        IERC20(bearerToken).safeTransferFrom(investor, address(this), amountToInvest);
    }

    /**
     * @inheritdoc IQuexOracleReceiver
     */
    function quexCallback(uint256 receivedRequestId, DataItem memory response) external {
        if (msg.sender != IQuexOracle(IUFarmCore(_ufarmCore).priceOracle()).getQuexCore()) {
            revert InvalidQuexCore(msg.sender);
        }

        if (receivedRequestId != requestId) {
            revert InvalidQuexRequestId(requestId, receivedRequestId);
        }

        _totalCost = abi.decode(response.value, (uint256));

        IPoolAdmin.PoolConfig memory config = IPoolAdmin(poolAdmin).getConfig();
        _accrueFee(_totalCost, config.managementCommission, config.packedPerformanceFee);

        address investor;

        // DEPOSITS
        {
            uint256 sharesToMint;
            uint256 amountToInvest;
            uint256 totalDeposit;
            bytes32 depositRequestHash;
            QueueItem memory depositItem;

            // Process items in straight order (from index 0)
            uint256 queueLength = depositQueue.length;
            for (uint256 i = 0; i < queueLength; i++) {
                // Validate each deposit request
                depositItem = depositQueue[i];
                amountToInvest = depositItem.amount;
                investor = depositItem.investor;
                depositRequestHash = depositItem.requestHash;

                // Execute the deposit action if it was not executed earlier
                if (__usedDepositsRequests[depositRequestHash] == false) {
                    sharesToMint = _sharesByQuote(amountToInvest, totalSupply(), _totalCost);
                    if (sharesToMint < depositItem.minOutputAmount) continue;

                    // Process the deposit
                    try this.safeTransferToPool(investor, amountToInvest, depositItem.bearerToken) {
                        _mintShares(investor, sharesToMint);

                        // Adjust the total cost and total deposit
                        _totalCost += amountToInvest;
                        totalDeposit += amountToInvest;

                        emit Deposit(investor, depositItem.bearerToken, amountToInvest, sharesToMint);

                        if (depositRequestHash != bytes32(0)) {
                            __usedDepositsRequests[depositRequestHash] = true;
                            emit DepositRequestExecuted(investor, depositRequestHash);
                        }
                    } catch {
                        // do nothing: the rest of the for block do the final work
                    }
                }
            }

            // Clear the entire queue in one operation by setting length to zero
            // This is more gas efficient than popping each item individually
            delete depositQueue;

            highWaterMark += totalDeposit;
        }

        // WITHDRAWALS
        {
            uint256 sharesToBurn;
            uint256 amountToWithdraw;
            bytes32 withdrawalRequestHash;
            QueueItem memory withdrawItem;
            uint256 availableToWithdraw;
            bool fundFail;

            // Process items in straight order (from index 0)
            uint256 queueLength = withdrawQueue.length;
            for (uint256 i = 0; i < queueLength; i++) {
                withdrawItem = withdrawQueue[i];
                sharesToBurn = withdrawItem.amount;
                withdrawalRequestHash = withdrawItem.requestHash;
                investor = withdrawItem.investor;

                if (investor == ufarmFund) {
                    // Check for the mandatory shares if pool is still active
                    uint256 valueTokensToRemain;
                    uint256 mandatoryShares;
                    if (status < PoolStatus.Deactivating) {
                        valueTokensToRemain = IUFarmCore(_ufarmCore).minimumFundDeposit();
                    } else {
                        valueTokensToRemain = _totalCost - IERC20(withdrawItem.bearerToken).balanceOf(address(this));
                    }

                    mandatoryShares = (valueTokensToRemain * totalSupply()) / _totalCost;

                    uint256 totalUserShares = balanceOf(investor);

                    availableToWithdraw = totalUserShares > mandatoryShares ? totalUserShares - mandatoryShares : 0;
                } else {
                    availableToWithdraw = balanceOf(investor);
                }

                // skip the withdraw action if not enough shares of it has already been executed
                if (sharesToBurn > availableToWithdraw || __usedWithdrawalsRequests[withdrawalRequestHash] == true) {
                    delete pendingWithdrawalsRequests[withdrawalRequestHash];
                    continue;
                }

                // Process the withdrawal
                (amountToWithdraw, fundFail) = _processWithdrawal(
                    investor,
                    sharesToBurn,
                    _totalCost,
                    withdrawalRequestHash,
                    withdrawItem.bearerToken,
                    withdrawItem.minOutputAmount
                );

                if (investor != ufarmFund && fundFail == false) {
                    if (unprocessedWithdraw == withdrawalRequestHash) {
                        unprocessedWithdraw = bytes32(0);
                    }

                    // Mark the request as used
                    __usedWithdrawalsRequests[withdrawalRequestHash] = true;

                    // Delete the request from the pending withdrawals
                    delete pendingWithdrawalsRequests[withdrawalRequestHash];
                }

                // Adjust the total cost
                _totalCost -= amountToWithdraw;
            }

            // Clear the entire queue in one operation
            delete withdrawQueue;
        }

        requestId = 0;
    }

    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4 magicValue) {
        magicValue = 0xffffffff;
    }

    function setUseArbitraryController(bool value) external override {
        UFarmPermissionsModel(address(ufarmFund)).checkForPermissionsMask(
            msg.sender,
            UFarmPermissionsModel(address(ufarmFund)).twoPermissionsToMask(
                uint8(Permissions.Fund.Member),
                uint8(Permissions.Fund.PoolStatusControl)
            )
        );
        if (!IUFarmCore(_ufarmCore).isAllowedArbitraryController(ufarmFund))
            revert NotAllowedToUseArbController(ufarmFund);
        _useArbitraryController = value;
    }

    function useArbitraryController() external view returns (bool) {
        return _useArbitraryController;
    }

    function setMinClientTier(uint8 value) external {
        UFarmPermissionsModel(address(ufarmFund)).checkForPermissionsMask(
            msg.sender,
            UFarmPermissionsModel(address(ufarmFund)).twoPermissionsToMask(
                uint8(Permissions.Fund.Member),
                uint8(Permissions.Fund.PoolStatusControl)
            )
        );
        minClientTier = value;
        emit ClientTierRequirementUpdated(value);
    }

    receive() external payable {}

    uint256 public actionDelayExpiration;

    uint256[41] private __gap;
}
