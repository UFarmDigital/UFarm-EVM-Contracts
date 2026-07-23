// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainTypes} from "./CrossChainTypes.sol";

library CrossChainStorage {
    bytes32 internal constant STORAGE_SLOT = keccak256("ufarm.vault.crosschain.adapter.storage");

    function state() internal pure returns (CrossChainTypes.CrossChainState storage state_) {
        bytes32 slot = STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            state_.slot := slot
        }
    }
}
