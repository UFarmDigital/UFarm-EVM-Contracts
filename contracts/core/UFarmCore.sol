// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmCurator} from "../interfaces/IUFarmCurator.sol";
import {IUFarmEscrow} from "../interfaces/IUFarmEscrow.sol";
import {IUFarmVaultBase} from "../interfaces/IUFarmVaultBase.sol";
import {IUFarmVaultRequests} from "../interfaces/IUFarmVaultRequests.sol";
import {IAggregatorV3} from "../interfaces/chainlink/IAggregatorV3.sol";
import {DeterministicDeployer} from "../libraries/DeterministicDeployer.sol";
import {DeterministicSalts} from "../libraries/DeterministicSalts.sol";
import {ErrorCodes} from "../libraries/ErrorCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {Unauthorized, InvalidAddress, InvalidConfig, CoreConfigError} from "./UFarmCoreErrors.sol";
import {
    CuratorPauseMaskUpdated,
    GlobalPauseMaskUpdated,
    CoreParameterUpdated,
    CCIPSelectorUpdated,
    PermissionUpdated,
    VaultAdapterUpdated,
    VaultModuleUpdated,
    VaultOracleUpdated,
    ProtocolFeeUpdated,
    ValueTokenUpdated,
    CuratorCreated
} from "./UFarmCoreEvents.sol";

contract UFarmCore is Initializable, UUPSUpgradeable, IUFarmCore {
    bytes32 public constant NAV_REQUEST_COOLDOWN_PARAMETER = keccak256("NAV_REQUEST_COOLDOWN");
    bytes32 public constant ORACLE_REQUEST_TIMEOUT_PARAMETER = keccak256("ORACLE_REQUEST_TIMEOUT");
    bytes32 public constant ALLOWED_PRICE_FLUCTUATION_PARAMETER = keccak256("ALLOWED_PRICE_FLUCTUATION");
    bytes32 public constant CROSS_CHAIN_ROUTER_PARAMETER = keccak256("CROSS_CHAIN_ROUTER");
    bytes32 public constant CROSS_CHAIN_FEE_TOKEN_PARAMETER = keccak256("CROSS_CHAIN_FEE_TOKEN");
    bytes32 public constant CROSS_CHAIN_TOKEN_PARAMETER = keccak256("CROSS_CHAIN_TOKEN");
    bytes32 public constant CROSS_CHAIN_GAS_LIMIT_PARAMETER = keccak256("CROSS_CHAIN_GAS_LIMIT");
    uint256 internal constant OWNER = Permissions.OWNER;
    uint256 internal constant ADMIN = Permissions.ADMIN;
    uint256 internal constant MEMBER = Permissions.MEMBER;
    uint256 internal constant CORE_CURATOR_REGISTRAR = Permissions.CORE_CURATOR_REGISTRAR;
    uint256 internal constant CORE_CONFIG_MANAGER = Permissions.CORE_CONFIG_MANAGER;
    uint256 internal constant CORE_ORACLE_MANAGER = Permissions.CORE_ORACLE_MANAGER;
    uint256 internal constant CORE_ADAPTER_MANAGER = Permissions.CORE_ADAPTER_MANAGER;
    uint256 internal constant CORE_PAUSE_MANAGER = Permissions.CORE_PAUSE_MANAGER;
    uint256 internal constant CORE_FINANCE_MANAGER = Permissions.CORE_FINANCE_MANAGER;
    uint256 internal constant CORE_MODULE_MANAGER = Permissions.CORE_MODULE_MANAGER;
    uint256 internal constant PROTOCOL_FEE_CAP = 0.1e18;
    uint256 internal constant ALLOWED_PRICE_FLUCTUATION_CAP = 1e18;
    uint256 internal constant DEFAULT_ORACLE_TIMING = 5 minutes;
    uint256 internal constant WAD = 1e18;

    // Permissions
    mapping(address account => uint256 mask) private _permissions;

    // Pause controls
    uint256 private _globalPauseMask;
    mapping(address curator => uint256 mask) private _curatorPauseMasks;

    // Protocol registries
    struct VaultConfig {
        address oracle;
        uint64 protocolFee;
        bool zeroUFarmFee;
        bool protocolFeeConfigured;
    }

    mapping(address asset => IUFarmCore.ValueTokenConfig config) private _valueTokenConfigs;
    mapping(address vault => VaultConfig config) private _vaultConfigs;
    mapping(bytes32 adapterId => mapping(address vault => address adapter)) private _vaultAdapters;
    mapping(bytes32 moduleId => address module) private _vaultModules;

    // Oracle and fee configuration
    uint256 private _navRequestCooldown;
    uint256 private _oracleRequestTimeout;
    uint256 private _allowedPriceFluctuation;

    // Immutable factory configuration
    address private _escrow;
    address private _deterministicDeployer;
    address private _curatorBeacon;
    address private _vaultBeacon;

    // Curator registry
    mapping(address curator => bool registered) private _curators;

    struct CoreCrossChainConfig {
        uint64 accountingChainId;
        address router;
        address feeToken;
        address token;
        uint256 gasLimit;
        mapping(uint64 chainId => uint64 selector) ccipSelectors;
    }

    CoreCrossChainConfig private _crossChainConfig;

    constructor() {
        _disableInitializers();
    }

    // --- Permission Modifiers ---

    modifier hasPermission(uint256 requiredMask) {
        _checkPermission(requiredMask);
        _;
    }

    modifier validAuthority(address authority) {
        if (authority == address(0)) revert InvalidAddress();
        _;
    }

    // --- Initialization and Upgrades ---

    /// @notice Initializes the core permission root.
    /// @param initialAuthority Address that receives the initial full permission mask.
    function initialize(address initialAuthority) external validAuthority(initialAuthority) initializer {
        _permissions[initialAuthority] = type(uint256).max;
        _navRequestCooldown = DEFAULT_ORACLE_TIMING;
        _oracleRequestTimeout = DEFAULT_ORACLE_TIMING;
        emit PermissionUpdated(initialAuthority, type(uint256).max);
    }

    /// @notice Initializes factory dependencies used for curator and vault deployment.
    /// @param escrow_ Escrow contract controlled by this core.
    /// @param deterministicDeployer_ Contract used for deterministic Create3 deployments.
    /// @param curatorBeacon_ Beacon used by curator proxies.
    /// @param vaultBeacon_ Beacon used by vault proxies.
    function initializeFactory(
        address escrow_,
        address deterministicDeployer_,
        address curatorBeacon_,
        address vaultBeacon_
    ) external reinitializer(2) hasPermission(OWNER) {
        if (
            escrow_ == address(0) || deterministicDeployer_ == address(0) || curatorBeacon_ == address(0)
                || vaultBeacon_ == address(0)
        ) revert InvalidAddress();
        if (
            escrow_.code.length == 0 || deterministicDeployer_.code.length == 0 || curatorBeacon_.code.length == 0
                || vaultBeacon_.code.length == 0
        ) revert InvalidAddress();
        if (IUFarmEscrow(escrow_).core() != address(this)) revert InvalidConfig();

        _escrow = escrow_;
        _deterministicDeployer = deterministicDeployer_;
        _curatorBeacon = curatorBeacon_;
        _vaultBeacon = vaultBeacon_;
    }

    /// @notice Initializes cross-chain accounting configuration.
    /// @dev The accounting core is intended for chains where the configured Chainlink price feeds are safe to consume
    ///      without an L2 sequencer uptime feed. Do not deploy the accounting core on an L2 unless sequencer-liveness
    ///      handling is added or otherwise provided.
    /// @param accountingChainId_ Chain id of the accounting chain.
    function initializeCrossChain(uint64 accountingChainId_) external reinitializer(3) hasPermission(OWNER) {
        if (accountingChainId_ == 0) revert CoreConfigError(ErrorCodes.CORE_INVALID_ACCOUNTING_CHAIN);
        if (_escrow == address(0)) revert CoreConfigError(ErrorCodes.CORE_FACTORY_NOT_CONFIGURED);
        _crossChainConfig.accountingChainId = accountingChainId_;
    }

    function _authorizeUpgrade(address) internal view override {
        _checkPermission(OWNER);
    }

    // --- Value Token Registry ---

    /// @notice Returns the value-token pricing configuration for an asset.
    /// @param asset Value-token address.
    /// @return config Stored pricing configuration, or an empty configuration if the asset is not configured.
    function valueTokenConfig(address asset) external view returns (IUFarmCore.ValueTokenConfig memory config) {
        return _valueTokenConfigs[asset];
    }

    /// @notice Configures a non-rebasing asset as a value token using a Chainlink-compatible USD price feed.
    /// @dev Rebasing, elastic-supply, fee-on-transfer, and balance-changing tokens are not supported as value tokens.
    ///      Escrow accounting records nominal token amounts and assumes balances only change through explicit transfers.
    /// @param asset Value-token address.
    /// @param feed Chainlink-compatible USD price feed.
    /// @param maxPriceAge Maximum accepted age of the latest feed answer, in seconds.
    /// @param minPrice Minimum accepted token price in USD WAD.
    /// @param maxPrice Maximum accepted token price in USD WAD.
    function setValueTokenConfig(address asset, address feed, uint32 maxPriceAge, uint96 minPrice, uint96 maxPrice)
        external
        hasPermission(MEMBER | CORE_CONFIG_MANAGER)
    {
        if (asset == address(0) || feed == address(0)) revert InvalidAddress();
        if (asset.code.length == 0 || feed.code.length == 0) revert InvalidAddress();
        if (maxPriceAge == 0 || minPrice == 0 || maxPrice == 0 || minPrice > maxPrice) revert InvalidConfig();

        uint8 tokenDecimals = _readDecimals(asset);
        uint8 feedDecimals = _readDecimals(feed);
        if (tokenDecimals > 18 || feedDecimals > 18) revert InvalidConfig();

        _valueTokenConfigs[asset] = IUFarmCore.ValueTokenConfig({
            feed: feed,
            tokenUnit: uint64(10 ** tokenDecimals),
            maxPriceAge: maxPriceAge,
            feedUnit: uint64(10 ** feedDecimals),
            minPrice: minPrice,
            maxPrice: maxPrice
        });

        if (_valueTokenPrice(_valueTokenConfigs[asset]) == 0) revert InvalidConfig();
        emit ValueTokenUpdated(asset, true);
    }

    /// @notice Removes the value-token pricing configuration for an asset.
    /// @param asset Value-token address.
    function clearValueTokenConfig(address asset) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        if (asset == address(0)) revert InvalidAddress();
        delete _valueTokenConfigs[asset];
        emit ValueTokenUpdated(asset, false);
    }

    /// @notice Converts a value-token amount into USD WAD using the current validated price.
    /// @dev Returns zero when the asset, feed answer, or conversion result is invalid.
    /// @param asset Value-token address.
    /// @param valueTokenAmount Amount in the value token's native decimals.
    /// @return usdAmount Converted value in USD WAD, or zero if pricing is invalid.
    function valueTokenToUsd(address asset, uint256 valueTokenAmount) external view returns (uint256 usdAmount) {
        if (valueTokenAmount == 0) return 0;

        IUFarmCore.ValueTokenConfig memory config = _valueTokenConfigs[asset];
        uint256 price = _valueTokenPrice(config);
        if (price == 0) return 0;

        return _mulDivOrZero(valueTokenAmount, price, config.tokenUnit);
    }

    /// @notice Converts a USD WAD amount into value-token units using the current validated price.
    /// @dev Returns zero when the asset, feed answer, or conversion result is invalid.
    /// @param asset Value-token address.
    /// @param usdAmount Value in USD WAD.
    /// @return valueTokenAmount Converted amount in the value token's native decimals, or zero if pricing is invalid.
    function usdToValueToken(address asset, uint256 usdAmount) external view returns (uint256 valueTokenAmount) {
        if (usdAmount == 0) return 0;

        IUFarmCore.ValueTokenConfig memory config = _valueTokenConfigs[asset];
        uint256 price = _valueTokenPrice(config);
        if (price == 0) return 0;

        return _mulDivOrZero(usdAmount, config.tokenUnit, price);
    }

    // --- Oracle Registry ---

    /// @notice Returns the oracle configured for a vault.
    /// @dev Falls back to the wildcard oracle stored at address zero.
    /// @param vaultAddress Vault address to resolve.
    /// @return oracle Oracle address, or zero if none is configured.
    function oracleForVault(address vaultAddress) public view returns (address oracle) {
        oracle = _vaultConfigs[vaultAddress].oracle;
        if (oracle == address(0)) {
            oracle = _vaultConfigs[address(0)].oracle;
        }
    }

    /// @notice Sets an oracle for a vault or for the wildcard fallback.
    /// @param vaultAddress Vault address, or address zero for the wildcard oracle.
    /// @param oracle Oracle address to set. Zero clears the entry.
    function setVaultOracle(address vaultAddress, address oracle) external hasPermission(MEMBER | CORE_ORACLE_MANAGER) {
        _vaultConfigs[vaultAddress].oracle = oracle;
        emit VaultOracleUpdated(vaultAddress, oracle);
    }

    // --- Adapter Registry ---

    /// @notice Returns the adapter configured for a vault.
    /// @dev Falls back to the wildcard adapter stored for address zero.
    /// @param adapterId Adapter identifier.
    /// @param vaultAddress Vault address to resolve.
    /// @return adapter Adapter address, or zero if none is configured.
    function adapterForVault(bytes32 adapterId, address vaultAddress) public view returns (address adapter) {
        adapter = _vaultAdapters[adapterId][vaultAddress];
        if (adapter == address(0)) {
            adapter = _vaultAdapters[adapterId][address(0)];
        }
    }

    /// @notice Sets an adapter for a vault or for the wildcard fallback.
    /// @param adapterId Adapter identifier.
    /// @param vaultAddress Vault address, or address zero for the wildcard adapter.
    /// @param adapter Adapter address to set. Zero clears the entry.
    function setVaultAdapter(bytes32 adapterId, address vaultAddress, address adapter)
        external
        hasPermission(MEMBER | CORE_ADAPTER_MANAGER)
    {
        if (adapter != address(0) && adapter.code.length == 0) revert InvalidAddress();
        _vaultAdapters[adapterId][vaultAddress] = adapter;
        emit VaultAdapterUpdated(adapterId, vaultAddress, adapter);
    }

    // --- Vault Module Registry ---

    /// @notice Returns a vault module implementation address.
    /// @param moduleId Module identifier.
    /// @return module Module implementation address.
    function vaultModule(bytes32 moduleId) external view returns (address module) {
        return _vaultModules[moduleId];
    }

    /// @notice Sets a vault module implementation.
    /// @param moduleId Module identifier.
    /// @param module Module implementation address.
    function setVaultModule(bytes32 moduleId, address module) external hasPermission(OWNER) {
        if (moduleId == bytes32(0)) revert InvalidConfig();
        if (module == address(0) || module.code.length == 0) revert InvalidAddress();
        _vaultModules[moduleId] = module;
        emit VaultModuleUpdated(moduleId, module);
    }

    // --- Permissions ---

    /// @notice Sets a core permission mask for an account.
    /// @param account Address whose permissions are updated.
    /// @param newMask New permission bit mask.
    function setPermissionMask(address account, uint256 newMask) external {
        if (account == address(0)) revert InvalidAddress();
        uint256 previous = _permissions[account];
        _checkCanSetPermissionMask(previous, newMask);
        _permissions[account] = newMask;
        emit PermissionUpdated(account, newMask);
    }

    /// @notice Returns an account's core permission mask.
    /// @param account Address to inspect.
    /// @return Current permission bit mask.
    function permissionMask(address account) external view returns (uint256) {
        return _permissions[account];
    }

    /// @notice Checks whether an account has all required core permissions.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits that must all be present.
    /// @return True when the account has every required permission.
    function accountHasPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAll(_permissions[account], requiredMask);
    }

    /// @notice Checks whether an account has any required core permission.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits where at least one must be present.
    /// @return True when the account has at least one required permission.
    function accountHasAnyPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAny(_permissions[account], requiredMask);
    }

    // --- Pause Controls ---

    /// @notice Sets the global pause mask.
    /// @param newMask New global pause bit mask.
    function setGlobalPauseMask(uint256 newMask) external hasPermission(MEMBER | CORE_PAUSE_MANAGER) {
        _globalPauseMask = newMask;
        emit GlobalPauseMaskUpdated(newMask);
    }

    /// @notice Returns the global pause mask.
    /// @return Current global pause bit mask.
    function globalPauseMask() external view returns (uint256) {
        return _globalPauseMask;
    }

    /// @notice Sets the pause mask for a curator.
    /// @param curator Curator address to update.
    /// @param newMask New curator pause bit mask.
    function setCuratorPauseMask(address curator, uint256 newMask) external hasPermission(MEMBER | CORE_PAUSE_MANAGER) {
        if (curator == address(0)) revert InvalidAddress();
        _curatorPauseMasks[curator] = newMask;
        emit CuratorPauseMaskUpdated(curator, newMask);
    }

    /// @notice Returns the pause mask for a curator.
    /// @param curator Curator address to inspect.
    /// @return Current curator pause bit mask.
    function curatorPauseMask(address curator) external view returns (uint256) {
        return _curatorPauseMasks[curator];
    }

    // --- Oracle Timing Configuration ---

    /// @notice Sets the cooldown after oracle settlement.
    /// @param newCooldown New cooldown duration in seconds.
    function setNavRequestCooldown(uint256 newCooldown) external hasPermission(MEMBER | CORE_ORACLE_MANAGER) {
        if (newCooldown == 0) revert InvalidConfig();
        _navRequestCooldown = newCooldown;
        emit CoreParameterUpdated(NAV_REQUEST_COOLDOWN_PARAMETER, newCooldown);
    }

    /// @notice Returns the cooldown after oracle settlement.
    /// @return Cooldown duration in seconds.
    function navRequestCooldown() external view returns (uint256) {
        return _navRequestCooldown;
    }

    /// @notice Sets the timeout for active oracle requests.
    /// @param newTimeout New timeout duration in seconds.
    function setOracleRequestTimeout(uint256 newTimeout) external hasPermission(MEMBER | CORE_ORACLE_MANAGER) {
        if (newTimeout == 0) revert InvalidConfig();
        _oracleRequestTimeout = newTimeout;
        emit CoreParameterUpdated(ORACLE_REQUEST_TIMEOUT_PARAMETER, newTimeout);
    }

    /// @notice Returns the timeout for active oracle requests.
    /// @return Timeout duration in seconds.
    function oracleRequestTimeout() external view returns (uint256) {
        return _oracleRequestTimeout;
    }

    // --- Fee Configuration ---

    /// @notice Sets the protocol fee and UFarm split override for a vault or wildcard fallback.
    /// @param vaultAddress Vault address, or address zero for the wildcard configuration.
    /// @param newFee New protocol fee in WAD units.
    /// @param zeroUFarmFee Whether curator fees are sent entirely to the curator.
    function setProtocolFee(address vaultAddress, uint256 newFee, bool zeroUFarmFee)
        external
        hasPermission(MEMBER | CORE_CONFIG_MANAGER)
    {
        if (newFee > PROTOCOL_FEE_CAP) revert CoreConfigError(ErrorCodes.CORE_INVALID_FEE);
        VaultConfig storage config = _vaultConfigs[vaultAddress];
        config.protocolFee = uint64(newFee);
        config.zeroUFarmFee = zeroUFarmFee;
        config.protocolFeeConfigured = true;
        emit ProtocolFeeUpdated(vaultAddress, newFee, zeroUFarmFee, true);
    }

    /// @notice Returns the protocol fee and UFarm split override for a vault.
    /// @dev Falls back to the wildcard configuration stored at address zero.
    function protocolFee(address vaultAddress) external view returns (uint256 fee, bool zeroUFarmFee) {
        VaultConfig storage config = _vaultConfigs[vaultAddress];
        if (config.protocolFeeConfigured) return (config.protocolFee, config.zeroUFarmFee);

        VaultConfig storage wildcard = _vaultConfigs[address(0)];
        if (!wildcard.protocolFeeConfigured) return (0, false);
        return (wildcard.protocolFee, wildcard.zeroUFarmFee);
    }

    /// @notice Clears a vault-specific or wildcard protocol fee configuration.
    /// @dev Preserves the oracle packed into the same vault configuration.
    function clearProtocolFee(address vaultAddress) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        VaultConfig storage config = _vaultConfigs[vaultAddress];
        delete config.protocolFee;
        delete config.zeroUFarmFee;
        delete config.protocolFeeConfigured;
        emit ProtocolFeeUpdated(vaultAddress, 0, false, false);
    }

    /// @notice Sets the allowed NAV price fluctuation.
    /// @param newLimit New allowed price movement limit in WAD units.
    function setAllowedPriceFluctuation(uint256 newLimit) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        if (newLimit > ALLOWED_PRICE_FLUCTUATION_CAP) {
            revert CoreConfigError(ErrorCodes.CORE_INVALID_PRICE_FLUCTUATION);
        }
        _allowedPriceFluctuation = newLimit;
        emit CoreParameterUpdated(ALLOWED_PRICE_FLUCTUATION_PARAMETER, newLimit);
    }

    /// @notice Returns the allowed NAV price fluctuation.
    /// @return Allowed price movement limit in WAD units.
    function allowedPriceFluctuation() external view returns (uint256) {
        return _allowedPriceFluctuation;
    }

    // --- Cross-chain Configuration ---

    /// @notice Returns the accounting chain id.
    /// @return Accounting chain id.
    function accountingChainId() external view returns (uint64) {
        return _crossChainConfig.accountingChainId;
    }

    /// @notice Returns the configured CCIP router.
    /// @return CCIP router address.
    function crossChainRouter() external view returns (address) {
        return _crossChainConfig.router;
    }

    /// @notice Returns the token used to pay CCIP fees.
    /// @return CCIP fee token address.
    function crossChainFeeToken() external view returns (address) {
        return _crossChainConfig.feeToken;
    }

    /// @notice Returns the token bridged by cross-chain transfers.
    /// @return Cross-chain value token address.
    function crossChainToken() external view returns (address) {
        return _crossChainConfig.token;
    }

    /// @notice Returns the CCIP gas limit used for outbound messages.
    /// @return CCIP gas limit.
    function crossChainGasLimit() external view returns (uint256) {
        return _crossChainConfig.gasLimit;
    }

    /// @notice Returns the CCIP selector for a chain id.
    /// @param chainId Chain id to resolve.
    /// @return CCIP chain selector.
    function ccipSelectorForChain(uint64 chainId) external view returns (uint64) {
        return _crossChainConfig.ccipSelectors[chainId];
    }

    /// @notice Sets the CCIP router address.
    /// @param newRouter New router address. Zero clears the router.
    function setCrossChainRouter(address newRouter) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        _crossChainConfig.router = newRouter;
        emit CoreParameterUpdated(CROSS_CHAIN_ROUTER_PARAMETER, uint256(uint160(newRouter)));
    }

    /// @notice Sets the token used to pay CCIP fees.
    /// @param newFeeToken New fee token address. Zero clears the fee token.
    function setCrossChainFeeToken(address newFeeToken) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        _crossChainConfig.feeToken = newFeeToken;
        emit CoreParameterUpdated(CROSS_CHAIN_FEE_TOKEN_PARAMETER, uint256(uint160(newFeeToken)));
    }

    /// @notice Sets the token bridged by cross-chain transfers.
    /// @param newToken New cross-chain token address. Zero clears the token.
    function setCrossChainToken(address newToken) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        _crossChainConfig.token = newToken;
        emit CoreParameterUpdated(CROSS_CHAIN_TOKEN_PARAMETER, uint256(uint160(newToken)));
    }

    /// @notice Sets the gas limit used for outbound CCIP messages.
    /// @param newGasLimit New CCIP gas limit.
    function setCrossChainGasLimit(uint256 newGasLimit) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        if (newGasLimit == 0) revert CoreConfigError(ErrorCodes.CORE_INVALID_CROSS_CHAIN_GAS_LIMIT);
        _crossChainConfig.gasLimit = newGasLimit;
        emit CoreParameterUpdated(CROSS_CHAIN_GAS_LIMIT_PARAMETER, newGasLimit);
    }

    /// @notice Sets the CCIP selector for a chain id.
    /// @dev This only records routing metadata. Deployment operators must confirm that the target chain supports the
    ///      bytecode generated by the repository EVM version, including Shanghai/Cancun opcodes such as PUSH0.
    /// @param chainId Chain id to update.
    /// @param selector CCIP selector for the chain. Zero clears the selector.
    function setCCIPSelector(uint64 chainId, uint64 selector) external hasPermission(MEMBER | CORE_CONFIG_MANAGER) {
        if (chainId == 0) revert CoreConfigError(ErrorCodes.CORE_INVALID_ACCOUNTING_CHAIN);
        _crossChainConfig.ccipSelectors[chainId] = selector;
        emit CCIPSelectorUpdated(chainId, selector);
    }

    // --- Factory Configuration Views ---

    /// @notice Returns the protocol escrow contract.
    /// @return Escrow contract address.
    function escrow() external view returns (address) {
        return _escrow;
    }

    /// @notice Returns the deterministic deployer used by the factory.
    /// @return Deterministic deployer address.
    function deterministicDeployer() external view returns (address) {
        return _deterministicDeployer;
    }

    /// @notice Returns the curator proxy beacon.
    /// @return Curator beacon address.
    function curatorBeacon() external view returns (address) {
        return _curatorBeacon;
    }

    /// @notice Returns the vault proxy beacon.
    /// @return Vault beacon address.
    function vaultBeacon() external view returns (address) {
        return _vaultBeacon;
    }

    // --- Curator Factory and Registry ---

    /// @notice Checks whether a curator is registered.
    /// @param curator Curator address to inspect.
    /// @return True when the curator was created by this core.
    function isCurator(address curator) external view returns (bool) {
        return _curators[curator];
    }

    /// @notice Creates a new curator proxy.
    /// @param curatorOwner Address that receives full permissions on the curator.
    /// @param userSalt User-provided salt used to derive the curator address.
    /// @return curator Newly created curator address.
    function createCurator(address curatorOwner, bytes32 userSalt)
        external
        hasPermission(MEMBER | CORE_CURATOR_REGISTRAR)
        returns (address curator)
    {
        // slither-disable-start reentrancy-benign
        if (curatorOwner == address(0)) revert InvalidAddress();

        if (_deterministicDeployer == address(0)) revert CoreConfigError(ErrorCodes.CORE_FACTORY_NOT_CONFIGURED);
        if (_escrow == address(0)) revert CoreConfigError(ErrorCodes.CORE_ESCROW_NOT_CONFIGURED);
        if (_curatorBeacon == address(0)) revert CoreConfigError(ErrorCodes.CORE_BEACON_NOT_CONFIGURED);

        bytes32 logicalSalt = DeterministicSalts.curatorSalt(curatorOwner, userSalt);
        bytes memory initData = abi.encodeCall(IUFarmCurator.initialize, (address(this), curatorOwner, logicalSalt));
        // slither-disable-next-line too-many-digits
        bytes memory initCode = abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(_curatorBeacon, initData));

        curator = DeterministicDeployer.deployCreate3(_deterministicDeployer, logicalSalt, initCode);
        _curators[curator] = true;

        emit CuratorCreated(curatorOwner, logicalSalt, curator);
        // slither-disable-end reentrancy-benign
    }

    // --- Finance Operations ---

    /// @notice Approves or revokes a core finance operator on a vault.
    /// @param vault Vault address controlled by this core.
    /// @param operator Address to approve or revoke.
    /// @param approved True to approve the operator, false to revoke it.
    /// @return True when the vault operator setting is updated.
    function setVaultOperator(address vault, address operator, bool approved)
        external
        hasPermission(MEMBER | CORE_FINANCE_MANAGER)
        returns (bool)
    {
        _checkProtocolVault(vault);
        return IUFarmVaultRequests(vault).setOperator(operator, approved);
    }

    /// @notice Requests redemption of shares owned by this core.
    /// @param vault Vault address controlled by this core.
    /// @param shares Number of core-owned shares to redeem.
    /// @return requestId Vault request identifier.
    function requestVaultRedeem(address vault, uint256 shares)
        external
        hasPermission(MEMBER | CORE_FINANCE_MANAGER)
        returns (uint256 requestId)
    {
        _checkProtocolVault(vault);
        return IUFarmVaultRequests(vault).requestRedeem(shares, address(this), address(this));
    }

    /// @notice Claims a redeem owned by the core from a vault.
    /// @param vault Vault address controlled by this core.
    /// @param receiver Address that receives the redeemed assets.
    /// @return assets Amount claimed.
    function claimVaultRedeem(address vault, address receiver)
        external
        hasPermission(MEMBER | CORE_FINANCE_MANAGER)
        returns (uint256 assets)
    {
        _checkProtocolVault(vault);
        return IUFarmVaultRequests(vault).redeem(0, receiver, address(this));
    }

    // --- Permission Internals ---

    function _checkPermission(uint256 requiredMask) internal view {
        if (!Permissions.hasAll(_permissions[msg.sender], requiredMask)) revert Unauthorized(msg.sender);
    }

    function _checkCanSetPermissionMask(uint256 previousMask, uint256 newMask) internal view {
        if (Permissions.hasAll(_permissions[msg.sender], OWNER)) return;
        if (!Permissions.hasAll(_permissions[msg.sender], ADMIN)) revert Unauthorized(msg.sender);
        if (((previousMask ^ newMask) & OWNER) != 0) revert Unauthorized(msg.sender);
    }

    function _checkProtocolVault(address vault) internal view {
        if (vault == address(0)) revert InvalidAddress();
        IUFarmVaultBase vaultContract = IUFarmVaultBase(vault);
        if (vaultContract.core() != address(this)) revert InvalidConfig();
        address curator = vaultContract.curator();
        if (!_curators[curator]) revert InvalidConfig();
        if (!IUFarmCurator(curator).isVault(vault)) revert InvalidConfig();
    }

    function _readDecimals(address target) internal view returns (uint8 decimals_) {
        try IERC20Metadata(target).decimals() returns (uint8 value) {
            return value;
        } catch {
            revert InvalidConfig();
        }
    }

    function _valueTokenPrice(IUFarmCore.ValueTokenConfig memory config) internal view returns (uint256) {
        if (config.feed == address(0)) return 0;

        // slither-disable-next-line unused-return
        try IAggregatorV3(config.feed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return 0;
            if (block.timestamp - updatedAt > config.maxPriceAge) return 0;

            uint256 price = _mulDivOrZero(uint256(answer), WAD, config.feedUnit);
            if (price < config.minPrice || price > config.maxPrice) return 0;
            return price;
        } catch {
            return 0;
        }
    }

    function _mulDivOrZero(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256) {
        if (x == 0 || y == 0 || denominator == 0) return 0;

        // slither-disable-next-line unused-return
        (uint256 productHigh,) = Math.mul512(x, y);
        if (productHigh >= denominator) return 0;

        return Math.mulDiv(x, y, denominator);
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
