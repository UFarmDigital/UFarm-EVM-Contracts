// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {VaultTypes} from "./VaultTypes.sol";

library VaultConfigStorage {
    bytes32 internal constant STORAGE_SLOT = 0x6390ba7b5bce174db20e37aa5137363a2b621c03ac87eb4639587ac3f1944757;

    struct Layout {
        uint256 managementFee;
        uint256 performanceFeeSchedule;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint8 clientTier;
        VaultTypes.VaultStatus status;
        bool transferRestricted;
    }

    function data() internal pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
