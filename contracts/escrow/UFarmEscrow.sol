// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmVaultBase} from "../interfaces/IUFarmVaultBase.sol";
import {IUFarmCurator} from "../interfaces/IUFarmCurator.sol";
import {IUFarmEscrow} from "../interfaces/IUFarmEscrow.sol";
import {PauseMask} from "../libraries/PauseMask.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {AssetLocked, InvalidAddress, InvalidAmount, InsufficientLiquidity, Unauthorized} from "./UFarmEscrowErrors.sol";
import {EscrowCredited, EscrowReleased, EscrowUnlocked, EscrowWithdrawn} from "./UFarmEscrowEvents.sol";

contract UFarmEscrow is Initializable, UUPSUpgradeable, IUFarmEscrow {
    using SafeERC20 for IERC20;

    struct EscrowBalance {
        uint256 amount;
        uint64 lockedTill;
    }

    // Core identity
    address private _core;

    // Custody ledger
    mapping(address vault => mapping(address asset => mapping(address beneficiary => EscrowBalance balance))) private
        _balances;

    constructor() {
        _disableInitializers();
    }

    // --- Initialization and Upgrades ---

    /// @notice Initializes the escrow proxy.
    /// @param core_ UFarm core contract address.
    function initialize(address core_) external initializer {
        if (core_ == address(0)) revert InvalidAddress();
        _core = core_;
    }

    function _authorizeUpgrade(address) internal view override {
        if (!IUFarmCore(_core).accountHasPermission(msg.sender, Permissions.OWNER)) revert Unauthorized(msg.sender);
    }

    // --- Core Identity ---

    /// @notice Returns the UFarm core contract address.
    /// @return Core contract address.
    function core() external view returns (address) {
        return _core;
    }

    // --- Custody Mutations ---

    /// @notice Credits assets from a user into escrow for a vault beneficiary.
    /// @dev Only registered vaults can call this method. The escrow ledger assumes standard non-rebasing ERC-20 behavior:
    ///      the credited amount must remain equal to the contract's actual token balance until an explicit transfer occurs.
    ///      Rebasing, elastic-supply, fee-on-transfer, and balance-changing tokens are unsupported.
    /// @param asset Asset token to transfer into escrow.
    /// @param from Address that sends the asset.
    /// @param beneficiary Address whose escrow balance is credited.
    /// @param amount Asset amount to credit.
    /// @param lockedTill Timestamp until which the balance is locked.
    function creditFrom(address asset, address from, address beneficiary, uint256 amount, uint64 lockedTill) external {
        _requireRegisteredVaultCaller();
        _checkNotPaused();
        if (asset == address(0) || from == address(0) || beneficiary == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        EscrowBalance storage balance = _balances[msg.sender][asset][beneficiary];
        balance.amount += amount;
        if (lockedTill > balance.lockedTill) {
            balance.lockedTill = lockedTill;
        }

        // slither-disable-next-line arbitrary-send-erc20
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        emit EscrowCredited(msg.sender, asset, beneficiary, amount, lockedTill);
    }

    /// @notice Releases escrowed assets to an arbitrary receiver.
    /// @dev Only the vault that owns the escrow balance can call this method.
    /// @param asset Asset token to release.
    /// @param beneficiary Address whose escrow balance is reduced.
    /// @param to Address that receives the released assets.
    /// @param amount Asset amount to release.
    function releaseTo(address asset, address beneficiary, address to, uint256 amount) external {
        _requireRegisteredVaultCaller();
        _checkNotPaused();
        _release(asset, beneficiary, to, amount);
    }

    /// @notice Releases escrowed assets back to the calling vault.
    /// @param asset Asset token to release.
    /// @param beneficiary Address whose escrow balance is reduced.
    /// @param amount Asset amount to release.
    function releaseToVault(address asset, address beneficiary, uint256 amount) external {
        _requireRegisteredVaultCaller();
        _checkNotPaused();
        _release(asset, beneficiary, msg.sender, amount);
    }

    /// @notice Unlocks a beneficiary escrow balance for withdrawal.
    /// @param asset Asset token to unlock.
    /// @param beneficiary Address whose balance is unlocked.
    function unlock(address asset, address beneficiary) external {
        _requireRegisteredVaultCaller();
        _checkNotPaused();
        if (asset == address(0) || beneficiary == address(0)) revert InvalidAddress();

        EscrowBalance storage balance = _balances[msg.sender][asset][beneficiary];
        balance.lockedTill = 0;
        emit EscrowUnlocked(msg.sender, asset, beneficiary, balance.amount);
    }

    /// @notice Withdraws unlocked escrowed assets.
    /// @param vault Vault whose escrow ledger is used.
    /// @param asset Asset token to withdraw.
    /// @param amount Asset amount to withdraw.
    /// @param to Address that receives the assets.
    function withdraw(address vault, address asset, uint256 amount, address to) external {
        _checkNotPaused();
        if (vault == address(0) || asset == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        EscrowBalance storage balance = _balances[vault][asset][msg.sender];
        if (balance.amount < amount) revert InsufficientLiquidity();
        uint64 lockedTill = balance.lockedTill;
        if (lockedTill > block.timestamp) revert AssetLocked(lockedTill);

        balance.amount -= amount;
        if (balance.amount == 0) {
            balance.lockedTill = 0;
        }

        IERC20(asset).safeTransfer(to, amount);
        emit EscrowWithdrawn(vault, asset, msg.sender, to, amount);
    }

    // --- Custody Views ---

    /// @notice Returns an escrow balance and its lock timestamp.
    /// @param vault Vault whose escrow ledger is read.
    /// @param asset Asset token to inspect.
    /// @param beneficiary Beneficiary address to inspect.
    /// @return amount Escrowed asset amount.
    /// @return lockedTill Timestamp until which the balance is locked.
    function balanceOf(address vault, address asset, address beneficiary)
        external
        view
        returns (uint256 amount, uint64 lockedTill)
    {
        EscrowBalance storage balance = _balances[vault][asset][beneficiary];
        return (balance.amount, balance.lockedTill);
    }

    // --- Custody Internals ---

    function _release(address asset, address beneficiary, address to, uint256 amount) internal {
        if (asset == address(0) || beneficiary == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        EscrowBalance storage balance = _balances[msg.sender][asset][beneficiary];
        if (balance.amount < amount) revert InsufficientLiquidity();
        balance.amount -= amount;
        if (balance.amount == 0) {
            balance.lockedTill = 0;
        }

        IERC20(asset).safeTransfer(to, amount);
        emit EscrowReleased(msg.sender, asset, beneficiary, to, amount);
    }

    function _requireRegisteredVaultCaller() internal view {
        if (msg.sender.code.length == 0) revert Unauthorized(msg.sender);

        address curator = IUFarmVaultBase(msg.sender).curator();
        if (!IUFarmCore(_core).isCurator(curator)) revert Unauthorized(msg.sender);
        if (!IUFarmCurator(curator).isVault(msg.sender)) revert Unauthorized(msg.sender);
    }

    function _checkNotPaused() internal view {
        uint256 globalMask = IUFarmCore(_core).globalPauseMask();
        if (
            PauseMask.isPaused(globalMask, PauseMask.FULL_PROTOCOL_PAUSE)
                || PauseMask.isPaused(globalMask, PauseMask.ESCROW_OPERATIONS_PAUSED)
        ) {
            revert Unauthorized(msg.sender);
        }
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
