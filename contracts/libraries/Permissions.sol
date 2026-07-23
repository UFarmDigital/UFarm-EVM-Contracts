// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library Permissions {
    uint256 internal constant OWNER = 1 << 255;
    uint256 internal constant ADMIN = 1 << 254;
    uint256 internal constant MEMBER = 1 << 253;
    uint256 internal constant CORE_CURATOR_REGISTRAR = 1 << 0;
    uint256 internal constant CORE_CONFIG_MANAGER = 1 << 1;
    uint256 internal constant CORE_ORACLE_MANAGER = 1 << 2;
    uint256 internal constant CORE_ADAPTER_MANAGER = 1 << 3;
    uint256 internal constant CORE_PAUSE_MANAGER = 1 << 4;
    uint256 internal constant CORE_FINANCE_MANAGER = 1 << 5;
    uint256 internal constant CORE_MODULE_MANAGER = 1 << 6;
    uint256 internal constant CORE_PRICE_GUARD_MANAGER = 1 << 7;
    uint256 internal constant CORE_CROSSCHAIN_GUARD_MANAGER = 1 << 8;
    uint256 internal constant CURATOR_VAULT_CREATOR = 1 << 0;
    uint256 internal constant CURATOR_FINANCE_MANAGER = 1 << 1;
    uint256 internal constant VAULT_ASSET_MANAGER = 1 << 0;
    uint256 internal constant VAULT_SETTLE_MANAGER = 1 << 1;
    uint256 internal constant VAULT_CONFIG_MANAGER = 1 << 2;
    uint256 internal constant VAULT_CUSTOMER_MANAGER = 1 << 3;

    function has(uint256 mask, uint256 permissionMask) internal pure returns (bool) {
        return hasAll(mask, permissionMask);
    }

    function hasAll(uint256 mask, uint256 permissionMask) internal pure returns (bool) {
        return permissionMask != 0 && (mask & permissionMask) == permissionMask;
    }

    function hasAny(uint256 mask, uint256 permissionMask) internal pure returns (bool) {
        return permissionMask != 0 && (mask & permissionMask) != 0;
    }

    function grant(uint256 mask, uint256 permission) internal pure returns (uint256) {
        return mask | permission;
    }

    function revoke(uint256 mask, uint256 permission) internal pure returns (uint256) {
        return mask & ~permission;
    }
}
