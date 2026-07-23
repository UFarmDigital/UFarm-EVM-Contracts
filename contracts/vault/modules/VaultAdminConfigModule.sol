// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {FeeMath} from "../../libraries/FeeMath.sol";
import {ErrorCodes} from "../../libraries/ErrorCodes.sol";
import {Permissions} from "../../libraries/Permissions.sol";
import {VaultBaseStorage} from "../../libraries/VaultBaseStorage.sol";
import {VaultConfigStorage} from "../../libraries/VaultConfigStorage.sol";
import {VaultLifecycleStorage} from "../../libraries/VaultLifecycleStorage.sol";
import {VaultPermissionStorage} from "../../libraries/VaultPermissionStorage.sol";
import {VaultTypes} from "../../libraries/VaultTypes.sol";
import {IUFarmVaultErrors} from "../UFarmVaultErrors.sol";
import {IUFarmVaultAdminEvents, IUFarmVaultBaseEvents} from "../UFarmVaultEvents.sol";

contract VaultAdminConfigModule is IUFarmVaultAdminEvents, IUFarmVaultBaseEvents {
    uint256 internal constant MANAGEMENT_FEE_CAP = 0.1e18;
    uint256 internal constant MAX_PERFORMANCE_FEE_PERIOD = 366 days;
    uint256 internal constant PERFORMANCE_FEE_PERIOD_SHIFT = 128;
    uint256 internal constant OWNER = Permissions.OWNER;
    uint256 internal constant MEMBER = Permissions.MEMBER;
    uint256 internal constant VAULT_CONFIG_MANAGER = Permissions.VAULT_CONFIG_MANAGER;

    address private immutable _self;

    constructor() {
        _self = address(this);
    }

    modifier onlyDelegateCall() {
        if (address(this) == _self) revert IUFarmVaultErrors.ModuleDelegateCallOnly();
        _;
    }

    /// @notice Updates management and performance fee settings.
    /// @dev Fees are locked after shares have been minted.
    /// @param newManagementFee Annual management fee in WAD units.
    /// @param newPerformanceFeeSchedule Packed performance fee schedule.
    function setFees(uint256 newManagementFee, uint256 newPerformanceFeeSchedule) external onlyDelegateCall {
        _checkPermission(MEMBER | VAULT_CONFIG_MANAGER);
        if (VaultBaseStorage.data().totalSupply > 0) revert IUFarmVaultErrors.FeeConfigLocked();
        uint256 performanceFeePeriod = newPerformanceFeeSchedule >> PERFORMANCE_FEE_PERIOD_SHIFT;
        if (
            newManagementFee > MANAGEMENT_FEE_CAP || performanceFeePeriod > MAX_PERFORMANCE_FEE_PERIOD
                || !FeeMath.isValidPerformanceFeeSchedule(newPerformanceFeeSchedule)
        ) {
            revert IUFarmVaultErrors.InvalidAmount();
        }

        VaultConfigStorage.data().managementFee = newManagementFee;
        VaultConfigStorage.data().performanceFeeSchedule = newPerformanceFeeSchedule;

        emit VaultFeesUpdated(newManagementFee, newPerformanceFeeSchedule);
    }

    /// @notice Updates the public deposit investment range.
    /// @dev Setting minDeposit_ greater than maxDeposit_ intentionally disables public deposits by making the range
    ///      unsatisfiable. Use this only as an operator-controlled deposit block.
    /// @param minDeposit_ Minimum allowed public deposit value in USD WAD.
    /// @param maxDeposit_ Maximum allowed public deposit value in USD WAD.
    function setInvestmentRange(uint256 minDeposit_, uint256 maxDeposit_) external onlyDelegateCall {
        _checkPermission(MEMBER | VAULT_CONFIG_MANAGER);
        VaultConfigStorage.data().minDeposit = minDeposit_;
        VaultConfigStorage.data().maxDeposit = maxDeposit_;
        emit InvestmentRangeUpdated(minDeposit_, maxDeposit_);
    }

    /// @notice Updates the client tier required for custom deposits.
    /// @param newTier New required tier. Zero disables tier checks.
    function setClientTier(uint8 newTier) external onlyDelegateCall {
        _checkPermission(MEMBER | VAULT_CONFIG_MANAGER);
        VaultConfigStorage.data().clientTier = newTier;
        emit ClientTierUpdated(newTier);
    }

    /// @notice Enables or disables direct ERC-20 share transfers.
    function setTransferRestricted(bool restricted) external onlyDelegateCall {
        _checkPermission(MEMBER | VAULT_CONFIG_MANAGER);
        VaultConfigStorage.data().transferRestricted = restricted;
        emit TransferRestrictionUpdated(restricted);
    }

    /// @notice Irreversibly terminates the vault and prevents further deposit ingestion.
    /// @dev Only a vault owner may terminate the vault.
    function terminate() external onlyDelegateCall {
        _checkPermission(OWNER);
        VaultConfigStorage.Layout storage config = VaultConfigStorage.data();
        if (config.status != VaultTypes.VaultStatus.Active) revert IUFarmVaultErrors.VaultNotActive();
        VaultLifecycleStorage.Layout storage lifecycle = VaultLifecycleStorage.data();
        if (lifecycle.pendingDepositOwners.length != 0 || lifecycle.pendingRedeemOwners.length != 0) {
            revert IUFarmVaultErrors.RequestStateError(ErrorCodes.REQUEST_PENDING);
        }
        config.status = VaultTypes.VaultStatus.Terminated;
        emit VaultTerminated(msg.sender);
    }

    function _checkPermission(uint256 requiredMask) internal view {
        if (!Permissions.hasAll(VaultPermissionStorage.data().permissions[msg.sender], requiredMask)) {
            revert IUFarmVaultErrors.Unauthorized(msg.sender);
        }
    }
}
