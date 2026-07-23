// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library VaultModuleIds {
    bytes32 internal constant ADAPTER_GATEWAY = keccak256("ufarm.vault.module.adapter-gateway");
    bytes32 internal constant ADMIN_CONFIG = keccak256("ufarm.vault.module.admin-config");
    bytes32 internal constant LIFECYCLE = keccak256("ufarm.vault.module.lifecycle");
}
