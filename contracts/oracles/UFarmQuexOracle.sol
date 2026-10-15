// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
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
import {
    DataItem,
    Flow,
    HTTPRequest,
    IdType,
    IRequestOraclePool,
    IFlowRegistry,
    IQuexActionRegistry,
    QueryParameter,
    RequestHeader
} from "../interfaces/quex/IQuex.sol";
import {
    QuexActionDataUpdated,
    QuexFlowCacheInvalidated,
    QuexFlowCreated,
    QuexRequestCreated
} from "./UFarmQuexOracleEvents.sol";
import {
    InvalidAddress,
    InvalidConfig,
    OracleFlowError,
    QuexResponseError,
    Unauthorized
} from "./UFarmQuexOracleErrors.sol";

contract UFarmQuexOracle is Initializable, UUPSUpgradeable, IUFarmOracle, ReentrancyGuard {
    struct VaultFlow {
        uint256 flowId;
        uint256 flowVersion;
    }

    struct QuexActionData {
        address requestOraclePool;
        bool configured;
        HTTPRequest request;
        bytes32 patchId;
        bytes32 schemaId;
        bytes32 filterId;
        uint256 gasLimit;
    }

    /// @notice Core contract that owns protocol permissions and vault registry checks.
    address public core;
    /// @notice Quex core registry used to create flows and oracle requests.
    address public quexCore;

    /// @notice Quex subscription used to pay for NAV requests.
    uint256 public subscriptionId;
    /// @notice Version of the Quex action configuration used by cached vault flows.
    uint256 public flowVersion;
    QuexActionData private _actionData;

    // Vault flow and request routing
    mapping(address vault => VaultFlow flow) private _vaultFlows;
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
     * @notice Initializes the Quex oracle proxy.
     * @dev This does not configure the HTTP action data required for settlement. A CORE_ORACLE_MANAGER must call
     *      setQuexActionData before any vault can successfully request NAV through this oracle.
     * @param core_ Core contract that provides permissions and vault registry checks.
     * @param quexCore_ Quex core registry used to create flows and oracle requests.
     * @param subscriptionId_ Quex subscription used to pay for requests.
     */
    function initialize(address core_, address quexCore_, uint256 subscriptionId_) external initializer {
        if (core_ == address(0) || quexCore_ == address(0)) revert InvalidAddress();
        core = core_;
        quexCore = quexCore_;
        subscriptionId = subscriptionId_;
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

    function invalidateFlowCache() external onlyOracleManager {
        flowVersion += 1;
        emit QuexFlowCacheInvalidated(flowVersion);
    }

    /**
     * @notice Updates Quex request and action settings required for NAV settlement.
     * @dev Increments the flow version so vaults build new Quex flows on their next request. Until this function is called
     *      with valid deployment-specific data, requestNav reverts and vault settlement cannot start through this oracle.
     * @param requestOraclePool Quex request oracle pool used to register HTTP requests and actions.
     * @param request HTTP request template. The oracle adds the vault address as the reserved `id` query parameter.
     * @param patchId Quex patch id applied to the HTTP response.
     * @param schemaId Quex schema id used to validate the patched response.
     * @param filterId Quex filter id used to select the NAV value.
     * @param gasLimit Callback gas limit for the Quex flow.
     */
    function setQuexActionData(
        address requestOraclePool,
        HTTPRequest calldata request,
        bytes32 patchId,
        bytes32 schemaId,
        bytes32 filterId,
        uint256 gasLimit
    ) external onlyOracleManager {
        if (requestOraclePool == address(0) || gasLimit == 0 || bytes(request.host).length == 0) {
            revert InvalidConfig();
        }

        QuexActionData storage data = _actionData;
        data.requestOraclePool = requestOraclePool;
        data.request.method = request.method;
        data.request.host = request.host;
        data.request.path = request.path;
        data.request.body = request.body;
        delete data.request.headers;
        delete data.request.parameters;

        for (uint256 i = 0; i < request.headers.length; ++i) {
            data.request.headers.push(request.headers[i]);
        }
        for (uint256 i = 0; i < request.parameters.length; ++i) {
            if (_isReservedIdKey(request.parameters[i].key)) revert InvalidConfig();
            data.request.parameters.push(request.parameters[i]);
        }

        data.patchId = patchId;
        data.schemaId = schemaId;
        data.filterId = filterId;
        data.gasLimit = gasLimit;
        data.configured = true;
        flowVersion += 1;
        emit QuexActionDataUpdated(flowVersion);
    }

    // --- Quex State Views ---

    /**
     * @notice Returns the cached Quex flow for a vault.
     * @param vault Vault address to read.
     * @return Cached flow id and configuration version for the vault.
     */
    function vaultFlow(address vault) external view returns (VaultFlow memory) {
        return _vaultFlows[vault];
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
        // slither-disable-start reentrancy-no-eth
        _requireConfigured();
        VaultFlow storage cached = _vaultFlows[vault];
        if (cached.flowId != 0 && cached.flowVersion == flowVersion) {
            return cached.flowId;
        }

        QuexActionData storage data = _actionData;
        HTTPRequest memory request = _requestForVault(vault);
        bytes32 quexRequestId = IRequestOraclePool(data.requestOraclePool).addRequest(request);
        uint256 actionId = IRequestOraclePool(data.requestOraclePool)
            .addActionByParts(quexRequestId, data.patchId, data.schemaId, data.filterId);
        flowId = IFlowRegistry(quexCore)
            .createFlow(
                Flow({
                gasLimit: data.gasLimit,
                actionId: actionId,
                pool: data.requestOraclePool,
                consumer: address(this),
                callback: this.quexCallback.selector
            })
            );

        cached.flowId = flowId;
        cached.flowVersion = flowVersion;
        emit QuexFlowCreated(vault, flowId, flowVersion);
        // slither-disable-end reentrancy-no-eth
    }

    function _requestForVault(address vault) internal view returns (HTTPRequest memory request) {
        HTTPRequest storage stored = _actionData.request;
        request.method = stored.method;
        request.host = stored.host;
        request.path = stored.path;
        request.body = stored.body;

        request.headers = new RequestHeader[](stored.headers.length);
        for (uint256 i = 0; i < stored.headers.length; ++i) {
            request.headers[i] = stored.headers[i];
        }

        request.parameters = new QueryParameter[](stored.parameters.length + 1);
        for (uint256 i = 0; i < stored.parameters.length; ++i) {
            request.parameters[i] = stored.parameters[i];
        }
        request.parameters[stored.parameters.length] =
            QueryParameter({key: "id", value: Strings.toHexString(uint160(vault), 20)});
    }

    // --- Validation Internals ---

    function _isReservedIdKey(string calldata key) internal pure returns (bool) {
        bytes calldata keyBytes = bytes(key);
        return keyBytes.length == 2 && (keyBytes[0] == bytes1("i") || keyBytes[0] == bytes1("I"))
            && (keyBytes[1] == bytes1("d") || keyBytes[1] == bytes1("D"));
    }

    function _requireConfigured() internal view {
        if (!_actionData.configured || quexCore == address(0) || subscriptionId == 0) revert InvalidConfig();
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
