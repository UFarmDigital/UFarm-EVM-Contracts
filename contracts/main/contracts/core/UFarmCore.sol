// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

/// INTERFACES
import {IUFarmCore} from "./IUFarmCore.sol";
import {IFundFactory} from "../fund/FundFactory.sol";
import {IPoolFactory} from "../pool/PoolFactory.sol";
import {IUFarmCoreLink} from "../../shared/UFarmCoreLink.sol";
import {Permissions} from "../permissions/Permissions.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// CONTRACTS
import {CoreWhitelist, ICoreWhitelist} from "./CoreWhitelist.sol";
import {UFarmPermissionsModel} from "../permissions/UFarmPermissionsModel.sol";
import {ReentrancyGuardUpgradeable as ReentrancyGuard} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {UFarmOwnableUUPS} from "../../shared/UFarmOwnableUUPS.sol";

/// LIBRARIES
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title UFarmCore
 * @author https://ufarm.digital/
 * @notice UFarmCore is the core contract of the UFarm protocol.
 * Keeps track of all funds, assets, UFarm permissions, and fees.
 */
contract UFarmCore is IUFarmCore, CoreWhitelist, UFarmPermissionsModel, ReentrancyGuard, UFarmOwnableUUPS {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // Structure to hold both oracle address and protocol commission
    struct SpecificOracle {
        address oracle;
        uint256 protocolCommission;
    }

    /// @custom:oz-renamed-from protocolCommission
    uint256 private _protocolCommission;

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

    /// @custom:oz-renamed-from priceOracle
    address private _priceOracle;

    /**
     * @inheritdoc IUFarmCore
     */
    bool public isPaused;

    EnumerableSet.AddressSet private _funds;
    mapping(address => bool) private _allowArbitraryController;

    // Mapping to store specific price oracles and commission rates for certain addresses
    mapping(address => SpecificOracle) private _specificOracles;

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
    /**
     * @notice Emitted when the permission changes to use ArbitraryController in the pools of a given fund
     * @param fund - fund address
     * @param isAllowed - flag allowing to use ArbitraryController in pools of this fund
     */
    event FundArbCtrlPermissionUpdated(address indexed fund, bool isAllowed);
    /**
     * @notice Emitted when a specific oracle is set or removed for a pool
     * @param pool - pool address
     * @param oracle - oracle address (zero address if removed)
     * @param protocolCommission - protocol commission for the pool
     */
    event SpecificOracleChanged(address indexed pool, address oracle, uint256 protocolCommission);
    /**
     * @notice Emitted when the post action delay is updated
     * @param postActionDelay - new cooldown value
     */
    event PostActionDelayChanged(uint256 postActionDelay);

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
        address __priceOracle
    )
        external
        onlyDeployer
        nonZeroAddress(_admin)
        nonZeroAddress(_fundFactory)
        nonZeroAddress(_poolFactory)
        nonZeroAddress(__priceOracle)
        initializer
    {
        __init__UFarmOwnableUUPS();
        __init__UFarmCore_unchained(_admin, _fundFactory, _poolFactory, __priceOracle);
    }

    function __init__UFarmCore_unchained(
        address _admin,
        address _fundFactory,
        address _poolFactory,
        address __priceOracle
    ) internal onlyInitializing {
        _priceOracle = __priceOracle;
        IUFarmCoreLink(__priceOracle).coreCallback();

        fundFactory = IFundFactory(_fundFactory);
        IUFarmCoreLink(_fundFactory).coreCallback();

        poolFactory = IPoolFactory(_poolFactory);
        IUFarmCoreLink(_poolFactory).coreCallback();

        _updatePermissions(_admin, _FULL_PERMISSIONS_MASK);
        _postActionDelay = 5 minutes;
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ApproveFundCreation))
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
    {
        _blacklistTokens(_tokens);
    }

    /**
     * @notice Allows managers to use these tokens as value tokens
     * @param _tokens - array of token addresses to whitelist as value tokens
     */
    function whitelistValueTokens(
        address[] calldata _tokens
    )
        external
        override
        nonReentrant
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
    {
        _whitelistValueTokens(_tokens);
    }

    /**
     * @notice Disallows managers to use these tokens as value tokens
     * @param _tokens - array of token addresses to blacklist from value tokens
     */
    function blacklistValueTokens(
        address[] calldata _tokens
    )
        external
        override
        nonReentrant
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
    {
        _blacklistValueTokens(_tokens);
    }

    /**
     * @inheritdoc ICoreWhitelist
     */
    function getWhitelistedValueTokens() external view override returns (address[] memory valueTokens) {
        return _getWhitelistedValueTokens();
    }

    /**
     * @notice Allows the UFarm administrator to change permission of using ArbitraryController in the pools of a given fund
     * @param fund - fund address
     * @param isAllowed - flag allowing to use ArbitraryController in pools of this fund
     */
    function setAllowArbitraryController(
        address fund,
        bool isAllowed
    )
        external
        nonZeroAddress(fund)
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
    {
        _allowArbitraryController[fund] = isAllowed;
        emit FundArbCtrlPermissionUpdated(fund, isAllowed);
    }

    /**
     * @notice Checks if pools of a specific fund is allowed to use the ArbitraryController.
     * @param fund The address of the fund.
     * @return `true` if the fund is allowed, `false` otherwise.
     */
    function isAllowedArbitraryController(address fund) external view returns (bool) {
        return _allowArbitraryController[fund];
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageFundDeposit))
    {
        if (minimumFundDeposit != _minimumFundDeposit) {
            minimumFundDeposit = _minimumFundDeposit;
            emit MinimumFundDepositChanged(_minimumFundDeposit);
        } else revert ActionAlreadyDone();
    }

    /**
     * @inheritdoc IUFarmCore
     */
    function protocolCommission() external view returns (uint256) {
        SpecificOracle memory specificOracle = _specificOracles[msg.sender];
        if (specificOracle.oracle != address(0)) {
            return specificOracle.protocolCommission;
        }
        return _protocolCommission;
    }

    /**
     * @inheritdoc IUFarmCore
     */
    function setProtocolCommission(
        uint256 __protocolCommission
    )
        external
        override
        valueInRange(__protocolCommission, 0, 1e17)
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageFees))
    {
        if (_protocolCommission != __protocolCommission) {
            _protocolCommission = __protocolCommission;
            emit ProtocolCommissionChanged(__protocolCommission);
        } else revert ActionAlreadyDone();
    }

    /**
     * @inheritdoc IUFarmCore
     */
    function postActionDelay() external view override returns (uint256) {
        return _postActionDelay;
    }

    /**
     * @inheritdoc IUFarmCore
     */
    function setPostActionDelay(
        uint256 __postActionDelay
    )
        external
        override
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageQuexFeed))
    {
        if (_postActionDelay != __postActionDelay) {
            _postActionDelay = __postActionDelay;
            emit PostActionDelayChanged(__postActionDelay);
        } else revert ActionAlreadyDone();
    }

    /**
     * @inheritdoc IUFarmCore
     */
    function priceOracle() external view returns (address) {
        SpecificOracle memory specificOracle = _specificOracles[msg.sender];
        if (specificOracle.oracle != address(0)) {
            return specificOracle.oracle;
        }
        return _priceOracle;
    }

    /**
     * @notice Sets a specific price oracle and commission for a sender
     * @dev Only callable by users with appropriate permissions
     * @param pool The address of the pool to set the specific oracle for
     * @param oracleAddress The specific oracle address
     * @param commission The specific protocol commission
     */
    function setSpecificOracle(
        address pool,
        address oracleAddress,
        uint256 commission
    )
        external
        valueInRange(commission, 0, 1e17)
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageFees))
    {
        require(oracleAddress != address(0), "Invalid oracle address");
        _specificOracles[pool] = SpecificOracle({oracle: oracleAddress, protocolCommission: commission});
        emit SpecificOracleChanged(pool, oracleAddress, commission);
    }

    /**
     * @notice Removes a specific price oracle for a sender
     * @dev Only callable by users with appropriate permissions
     * @param pool The address of the pool to remove the specific oracle for
     */
    function removeSpecificOracle(
        address pool
    ) external ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageFees)) {
        delete _specificOracles[pool];
        emit SpecificOracleChanged(pool, address(0x0), 0);
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageWhitelist))
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
                            ? uint8(Permissions.UFarm.UpdateUFarmMember) // if becomes member
                            : uint8(Permissions.UFarm.DeleteUFarmMember) // else will be removed
                    )
                );
            }

            // shift right new bitmask for 2 bits, leaving only permissions (not Owner and Member roles)
            if ((_newPermissionsMask >> 2) > 0) {
                _checkForPermissions(
                    msg.sender,
                    _twoPermissionsToMask(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.UpdatePermissions))
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
        ownerOrHaveTwoPermissions(uint8(Permissions.UFarm.Member), uint8(Permissions.UFarm.ManageAssets))
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

    uint256 private _postActionDelay;

    uint256[47] private __gap;
}
