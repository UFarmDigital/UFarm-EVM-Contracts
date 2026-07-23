// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Permissions} from "./Permissions.sol";
import {VaultPermissionStorage} from "./VaultPermissionStorage.sol";
import {IUFarmVaultErrors} from "../vault/UFarmVaultErrors.sol";

library VaultAccessControl {
    function hasPermission(address account, uint256 requiredMask) internal view returns (bool) {
        return Permissions.hasAll(VaultPermissionStorage.data().permissions[account], requiredMask);
    }

    function checkPermission(address account, uint256 requiredMask) internal view {
        if (!hasPermission(account, requiredMask)) revert IUFarmVaultErrors.Unauthorized(account);
    }

    function checkCanSetPermissionMask(
        address caller,
        uint256 previousMask,
        uint256 newMask,
        uint256 ownerPermission,
        uint256 adminPermission
    ) internal view {
        if (hasPermission(caller, ownerPermission)) return;
        if (!hasPermission(caller, adminPermission)) revert IUFarmVaultErrors.Unauthorized(caller);
        if (((previousMask ^ newMask) & ownerPermission) != 0) revert IUFarmVaultErrors.Unauthorized(caller);
    }
}
