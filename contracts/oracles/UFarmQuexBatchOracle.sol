// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmCurator} from "../interfaces/IUFarmCurator.sol";
import {IUFarmOracleConsumer} from "../interfaces/IUFarmOracleConsumer.sol";
import {IUFarmOracle} from "../interfaces/IUFarmOracle.sol";
import {IUFarmVaultBase} from "../interfaces/IUFarmVaultBase.sol";
import {ErrorCodes} from "../libraries/ErrorCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {DataItem, Flow, IdType, IFlowRegistry, IQuexActionRegistry} from "../interfaces/quex/IQuex.sol";
import {
    QuexBatchConfigUpdated,
    QuexBatchActionDataUpdated,
    QuexVaultFlowCacheInvalidated,
    QuexFlowCreated,
    QuexRequestCreated
} from "./UFarmQuexBatchOracleEvents.sol";
import {
    InvalidAddress,
    InvalidConfig,
    OracleFlowError,
    QuexResponseError,
    Unauthorized
} from "./UFarmQuexOracleErrors.sol";

contract UFarmQuexBatchOracle is Initializable, UUPSUpgradeable, IUFarmOracle, ReentrancyGuard {
    struct VaultFlow {
        uint256 flowId;
        uint256 flowVersion;
    }

    struct VaultData {
        uint256 actionId;
        uint256 flowId;
        uint128 flowVersion;
        uint128 cachedFlowVersion;
    }

    /// @notice Core contract that owns protocol permissions and vault registry checks.
    address public core;
    /// @notice Quex core registry used to create flows and oracle requests.
    address public quexCore;

    /// @notice Quex subscription used to pay for NAV requests.
    uint256 public subscriptionId;
    /// @notice Quex request oracle pool used by newly created vault flows.
    address public requestOraclePool;
    /// @notice Callback gas limit used by newly created vault flows.
    uint96 public gasLimit;

    // Vault flow and request routing
    mapping(address vault => VaultData data) private _vaultData;
    mapping(uint256 requestId => address vault) private _vaultByRequestId;

    // --- Permission Modifiers ---

    modifier onlyOracleManager() {
        IUFarmCore core_ = IUFarmCore(core);
        if (!core_.accountHasPermission(msg.sender, Permissions.MEMBER | Permissions.CORE_ORACLE_MANAGER)) {
            revert Unauthorized(msg.sender);
        }
        _;
    }

    // --- Construction ---

    constructor() {
        _disableInitializers();
    }

    // --- Initialization and Upgrades ---

    /**
     * @notice Initializes the Quex batch oracle proxy.
     * @dev Each vault must have a batch action configured before it can successfully request NAV through this oracle.
     * @param core_ Core contract that provides permissions and vault registry checks.
     * @param quexCore_ Quex core registry used to create flows and oracle requests.
     * @param subscriptionId_ Quex subscription used to pay for requests.
     * @param requestOraclePool_ Quex request oracle pool used by created flows.
     * @param gasLimit_ Callback gas limit for created flows.
     */
    function initialize(
        address core_,
        address quexCore_,
        uint256 subscriptionId_,
        address requestOraclePool_,
        uint96 gasLimit_
    ) external initializer {
        if (core_ == address(0) || quexCore_ == address(0) || requestOraclePool_ == address(0)) {
            revert InvalidAddress();
        }
        if (gasLimit_ == 0) revert InvalidConfig();
        core = core_;
        quexCore = quexCore_;
        subscriptionId = subscriptionId_;
        requestOraclePool = requestOraclePool_;
        gasLimit = gasLimit_;
    }

    function _authorizeUpgrade(address) internal view override {
        if (!IUFarmCore(core).accountHasPermission(msg.sender, Permissions.OWNER)) revert Unauthorized(msg.sender);
    }

    // --- Quex Configuration ---

    /**
     * @notice Updates the Quex subscription used for future NAV requests.
     * @param newSubscriptionId New Quex subscription id.
     */
    function setQuexSubscriptionId(uint256 newSubscriptionId) external onlyOracleManager {
        subscriptionId = newSubscriptionId;
    }

    /**
     * @notice Updates the Quex pool and callback gas limit used for newly created flows.
     * @dev Cached flows remain unchanged. Operators must call invalidateFlowCache(vaults) or re-set each affected action.
     * @param newRequestOraclePool Quex request oracle pool used by newly created flows.
     * @param newGasLimit Callback gas limit used by newly created flows.
     */
    function setQuexConfig(address newRequestOraclePool, uint96 newGasLimit) external nonReentrant onlyOracleManager {
        if (newRequestOraclePool == address(0)) revert InvalidAddress();
        if (newGasLimit == 0) revert InvalidConfig();
        requestOraclePool = newRequestOraclePool;
        gasLimit = newGasLimit;
        emit QuexBatchConfigUpdated(newRequestOraclePool, newGasLimit);
    }

    /**
     * @notice Updates the Quex batch action used for a vault's NAV settlement.
     * @dev Increments the vault's flow version so it builds a new Quex flow on its next request. A zero action id disables
     *      new NAV requests for the vault.
     * @param vault Vault address to configure.
     * @param actionId Quex batch action id, or zero to disable the vault configuration.
     */
    function setQuexActionData(address vault, uint256 actionId) external nonReentrant onlyOracleManager {
        if (vault == address(0)) revert InvalidAddress();
        if (actionId != 0) _requireRegisteredVault(vault);
        VaultData storage data = _vaultData[vault];
        data.actionId = actionId;
        uint256 version = _incrementFlowVersion(data);
        emit QuexBatchActionDataUpdated(vault, actionId, version);
    }

    /**
     * @notice Invalidates cached Quex flows for the supplied vaults.
     * @param vaults Vault addresses whose flows must be rebuilt on their next NAV request.
     */
    function invalidateFlowCache(address[] calldata vaults) external nonReentrant onlyOracleManager {
        for (uint256 i = 0; i < vaults.length; ++i) {
            address vault = vaults[i];
            if (vault == address(0)) revert InvalidAddress();
            uint256 version = _incrementFlowVersion(_vaultData[vault]);
            emit QuexVaultFlowCacheInvalidated(vault, version);
        }
    }

    // --- Quex State Views ---

    /**
     * @notice Returns the Quex batch action and current flow version for a vault.
     * @param vault Vault address to read.
     * @return actionId Quex batch action id configured for the vault.
     * @return flowVersion Current configuration version for the vault.
     */
    function vaultActionData(address vault) external view returns (uint256 actionId, uint256 flowVersion) {
        VaultData storage data = _vaultData[vault];
        return (data.actionId, uint256(data.flowVersion));
    }

    /**
     * @notice Returns the cached Quex flow for a vault.
     * @param vault Vault address to read.
     * @return Cached flow id and configuration version for the vault.
     */
    function vaultFlow(address vault) external view returns (VaultFlow memory) {
        VaultData storage data = _vaultData[vault];
        return VaultFlow({flowId: data.flowId, flowVersion: uint256(data.cachedFlowVersion)});
    }

    /**
     * @notice Returns the vault that owns a Quex request id.
     * @param requestId Quex request id to read.
     * @return Vault address linked to the request, or zero when no request is pending.
     */
    function vaultByRequestId(uint256 requestId) external view returns (address) {
        return _vaultByRequestId[requestId];
    }

    // --- IUFarmOracle ---

    /**
     * @notice Requests a fresh NAV value for a vault.
     * @dev Only the vault itself may call this method. A Quex flow is created or refreshed when needed.
     * @param vault Vault address that requests valuation.
     * @return oracleRequestId Quex request id created for the NAV request.
     */
    function requestNav(address vault) external nonReentrant returns (uint256 oracleRequestId) {
        if (vault == address(0)) revert InvalidAddress();
        if (msg.sender != vault) revert Unauthorized(msg.sender);
        _requireRegisteredVault(vault);

        uint256 flowId = _flowForVault(vault);
        oracleRequestId = IQuexActionRegistry(quexCore).createRequest(flowId, subscriptionId);
        if (oracleRequestId == 0 || _vaultByRequestId[oracleRequestId] != address(0)) {
            revert OracleFlowError(ErrorCodes.ORACLE_INVALID_REQUEST);
        }

        // slither-disable-next-line reentrancy-benign
        _vaultByRequestId[oracleRequestId] = vault;
        emit QuexRequestCreated(vault, oracleRequestId);
    }

    // --- Flow Construction Internals ---

    function _flowForVault(address vault) internal returns (uint256 flowId) {
        VaultData storage data = _vaultData[vault];
        _requireConfigured(data);
        if (data.flowId != 0 && data.cachedFlowVersion == data.flowVersion) return data.flowId;

        // slither-disable-start reentrancy-no-eth
        flowId = IFlowRegistry(quexCore)
            .createFlow(
                Flow({
                gasLimit: gasLimit,
                actionId: data.actionId,
                pool: requestOraclePool,
                consumer: address(this),
                callback: this.quexCallback.selector
            })
            );
        data.flowId = flowId;
        data.cachedFlowVersion = data.flowVersion;
        emit QuexFlowCreated(vault, flowId, uint256(data.flowVersion));
        // slither-disable-end reentrancy-no-eth
    }

    function _incrementFlowVersion(VaultData storage data) internal returns (uint256 version) {
        data.flowVersion += 1;
        version = uint256(data.flowVersion);
    }

    // --- Validation Internals ---

    function _requireConfigured(VaultData storage data) internal view {
        if (
            data.actionId == 0 || quexCore == address(0) || subscriptionId == 0 || requestOraclePool == address(0)
                || gasLimit == 0
        ) revert InvalidConfig();
    }

    function _requireRegisteredVault(address vault) internal view {
        address curator = address(0);
        try IUFarmVaultBase(vault).curator() returns (address curator_) {
            curator = curator_;
        } catch {
            revert Unauthorized(vault);
        }
        IUFarmCore core_ = IUFarmCore(core);
        if (!core_.isCurator(curator)) revert Unauthorized(vault);
        if (!IUFarmCurator(curator).isVault(vault)) revert Unauthorized(vault);
    }

    // --- Quex Callback ---

    /**
     * @notice Receives a Quex response and forwards the NAV to the requesting vault.
     * @dev A non-zero Quex response error code reverts this callback. The vault oracle request then remains active until
     *      an authorized operator resolves it through timeout-based resetRequests or manualResendOracleRequest.
     * @param requestId Quex request id that is being fulfilled.
     * @param response Quex response data containing the NAV value and valuation timestamp.
     * @param idType Quex identifier type. Only request identifiers are accepted.
     */
    function quexCallback(uint256 requestId, DataItem calldata response, IdType idType) external virtual nonReentrant {
        if (msg.sender != quexCore) revert Unauthorized(msg.sender);
        if (idType != IdType.RequestId) revert OracleFlowError(ErrorCodes.ORACLE_INVALID_REQUEST);

        address vault = _vaultByRequestId[requestId];
        if (vault == address(0)) revert OracleFlowError(ErrorCodes.ORACLE_INVALID_REQUEST);
        if (response.errorCode != 0) revert QuexResponseError(response.errorCode);
        if (response.timestamp == 0 || response.timestamp > type(uint64).max) {
            revert OracleFlowError(ErrorCodes.ORACLE_INVALID_VALUATION_TIMESTAMP);
        }

        // Comes from QUEX with decimals=6
        uint256 nav = abi.decode(response.value, (uint256));
        delete _vaultByRequestId[requestId];

        IUFarmOracleConsumer(vault).onOracleNav(requestId, nav * 10 ** 12, uint64(response.timestamp));
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
