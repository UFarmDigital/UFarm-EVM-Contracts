// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IUFarmCurator} from "../interfaces/IUFarmCurator.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmVaultRequests} from "../interfaces/IUFarmVaultRequests.sol";
import {DeterministicDeployer} from "../libraries/DeterministicDeployer.sol";
import {DeterministicSalts} from "../libraries/DeterministicSalts.sol";
import {ErrorCodes} from "../libraries/ErrorCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {CuratorPermissionUpdated, VaultCreated} from "./UFarmCuratorEvents.sol";
import {
    CoreConfigError,
    CuratorNotRegistered,
    InvalidAddress,
    Unauthorized,
    VaultNotRegistered
} from "./UFarmCuratorErrors.sol";

contract UFarmCurator is Initializable, IUFarmCurator {
    uint256 public constant OWNER = Permissions.OWNER;
    uint256 public constant ADMIN = Permissions.ADMIN;
    uint256 public constant MEMBER = Permissions.MEMBER;
    uint256 public constant CURATOR_VAULT_CREATOR = Permissions.CURATOR_VAULT_CREATOR;
    uint256 public constant CURATOR_FINANCE_MANAGER = Permissions.CURATOR_FINANCE_MANAGER;

    // Core identity
    address private _core;
    bytes32 private _curatorSalt;

    // Permissions
    mapping(address account => uint256 mask) private _permissions;

    // Vault registry
    mapping(address vault => bool registered) private _isVault;

    constructor() {
        _disableInitializers();
    }

    // --- Initialization ---

    /// @notice Initializes a curator proxy.
    /// @param core_ UFarm core contract address.
    /// @param owner_ Address that receives the initial full curator permission mask.
    /// @param curatorSalt_ Salt used to derive and identify this curator.
    function initialize(address core_, address owner_, bytes32 curatorSalt_) external initializer {
        if (core_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        _core = core_;
        _curatorSalt = curatorSalt_;
        _permissions[owner_] = type(uint256).max;
        emit CuratorPermissionUpdated(owner_, type(uint256).max);
    }

    // --- Core Identity Views ---

    /// @notice Returns the UFarm core contract address.
    /// @return Core contract address.
    function core() external view returns (address) {
        return _core;
    }

    /// @notice Returns the curator deployment salt.
    /// @return Curator salt.
    function curatorSalt() external view returns (bytes32) {
        return _curatorSalt;
    }

    // --- Permission Modifiers ---

    modifier hasPermission(uint256 requiredMask) {
        _checkPermission(requiredMask);
        _;
    }

    // --- Permissions ---

    /// @notice Sets a curator permission mask for an account.
    /// @dev Permission changes are applied in one transaction. Granting or revoking OWNER is not a two-step transfer, so
    ///      operators should use controlled addresses such as multisigs or timelocks and verify recipients before changing
    ///      ownership permissions.
    /// @param account Address whose permissions are updated.
    /// @param newMask New permission bit mask.
    function setPermissionMask(address account, uint256 newMask) external {
        if (account == address(0)) revert InvalidAddress();
        uint256 previous = _permissions[account];
        _checkCanSetPermissionMask(previous, newMask);
        _permissions[account] = newMask;
        emit CuratorPermissionUpdated(account, newMask);
    }

    /// @notice Returns an account's curator permission mask.
    /// @param account Address to inspect.
    /// @return Current permission bit mask.
    function permissionMask(address account) external view returns (uint256) {
        return _permissions[account];
    }

    /// @notice Checks whether an account has all required curator permissions.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits that must all be present.
    /// @return True when the account has every required permission.
    function accountHasPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAll(_permissions[account], requiredMask);
    }

    /// @notice Checks whether an account has any required curator permission.
    /// @param account Address to inspect.
    /// @param requiredMask Permission bits where at least one must be present.
    /// @return True when the account has at least one required permission.
    function accountHasAnyPermission(address account, uint256 requiredMask) external view returns (bool) {
        return Permissions.hasAny(_permissions[account], requiredMask);
    }

    // --- Vault Factory and Registry ---

    /// @notice Checks whether a vault is registered under this curator.
    /// @param vault Vault address to inspect.
    /// @return True when the vault was created by this curator.
    function isVault(address vault) external view returns (bool) {
        return _isVault[vault];
    }

    /// @notice Creates a new vault owned by this curator.
    /// @param userSalt User-provided salt used to derive the vault address.
    /// @param vaultOwner Address that receives the initial full vault permission mask.
    /// @param name ERC-20 share token name.
    /// @param symbol ERC-20 share token symbol.
    /// @param asset Default value token for public deposits.
    /// @return vault Newly created vault address.
    function createVault(
        bytes32 userSalt,
        address vaultOwner,
        string calldata name,
        string calldata symbol,
        address asset
    ) external hasPermission(MEMBER | CURATOR_VAULT_CREATOR) returns (address vault) {
        // slither-disable-start reentrancy-benign
        IUFarmCore coreContract = IUFarmCore(_core);
        if (!coreContract.isCurator(address(this))) revert CuratorNotRegistered(address(this));

        address vaultBeacon = coreContract.vaultBeacon();
        if (vaultBeacon == address(0)) revert CoreConfigError(ErrorCodes.CORE_BEACON_NOT_CONFIGURED);

        bytes32 logicalSalt = DeterministicSalts.vaultSalt(address(this), userSalt);
        bytes memory initData = abi.encodeCall(
            IUFarmVaultRequests.initialize, (_core, address(this), vaultOwner, logicalSalt, name, symbol, asset)
        );
        // slither-disable-next-line too-many-digits
        bytes memory initCode = abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(vaultBeacon, initData));
        vault = DeterministicDeployer.deployCreate3(coreContract.deterministicDeployer(), logicalSalt, initCode);
        _isVault[vault] = true;
        emit VaultCreated(address(this), vaultOwner, logicalSalt, vault);
        // slither-disable-end reentrancy-benign
    }

    // --- Finance Operations ---

    /// @notice Approves or revokes a curator finance operator on a vault.
    /// @param vault Vault address registered under this curator.
    /// @param operator Address to approve or revoke.
    /// @param approved True to approve the operator, false to revoke it.
    /// @return True when the vault operator setting is updated.
    function setVaultOperator(address vault, address operator, bool approved)
        external
        hasPermission(MEMBER | CURATOR_FINANCE_MANAGER)
        returns (bool)
    {
        _checkCuratorVault(vault);
        return IUFarmVaultRequests(vault).setOperator(operator, approved);
    }

    /// @notice Requests redemption of shares owned by this curator.
    /// @param vault Vault address registered under this curator.
    /// @param shares Number of curator-owned shares to redeem.
    /// @return requestId Vault request identifier.
    function requestVaultRedeem(address vault, uint256 shares)
        external
        hasPermission(MEMBER | CURATOR_FINANCE_MANAGER)
        returns (uint256 requestId)
    {
        _checkCuratorVault(vault);
        return IUFarmVaultRequests(vault).requestRedeem(shares, address(this), address(this));
    }

    /// @notice Claims a redeem owned by the curator from a vault.
    /// @param vault Vault address registered under this curator.
    /// @param receiver Address that receives the redeemed assets.
    /// @return assets Amount claimed.
    function claimVaultRedeem(address vault, address receiver)
        external
        hasPermission(MEMBER | CURATOR_FINANCE_MANAGER)
        returns (uint256 assets)
    {
        _checkCuratorVault(vault);
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

    function _checkCuratorVault(address vault) internal view {
        if (vault == address(0)) revert InvalidAddress();
        if (!_isVault[vault]) revert VaultNotRegistered(vault);
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
