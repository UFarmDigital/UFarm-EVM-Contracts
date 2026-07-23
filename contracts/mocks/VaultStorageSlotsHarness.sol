// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

contract VaultStorageSlotsHarness {
    function baseSlot() external pure returns (bytes32) {
        return keccak256("ufarm.vault.base.storage");
    }

    function permissionSlot() external pure returns (bytes32) {
        return keccak256("ufarm.vault.permission.storage");
    }

    function lifecycleSlot() external pure returns (bytes32) {
        return keccak256("ufarm.vault.lifecycle.storage");
    }

    function configSlot() external pure returns (bytes32) {
        return keccak256("ufarm.vault.config.storage");
    }

    function crossChainSlot() external pure returns (bytes32) {
        return keccak256("ufarm.vault.crosschain.adapter.storage");
    }
}
