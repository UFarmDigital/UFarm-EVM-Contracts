// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {VaultTypes} from "./VaultTypes.sol";

library VaultPermissionStorage {
    bytes32 internal constant STORAGE_SLOT = 0x7ef2315b268348cb9a2452aa478134d37506a7b578c8fcd34673ac06353b38d2;

    struct Layout {
        mapping(address owner => VaultTypes.OperatorState state) operatorStates;
        mapping(address account => uint256 mask) permissions;
        mapping(bytes32 digest => bool signed) signedMessages;
    }

    function data() internal pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
