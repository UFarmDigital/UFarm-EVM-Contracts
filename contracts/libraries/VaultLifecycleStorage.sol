// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {VaultTypes} from "./VaultTypes.sol";

library VaultLifecycleStorage {
    bytes32 internal constant STORAGE_SLOT = 0xe8d173460f11c9616d61fdbdec43bdf9763d517a7240fec6194b8875258f523f;

    struct Layout {
        mapping(address owner => VaultTypes.OwnerRequestState state) requestStates;
        address[] pendingDepositOwners;
        address[] pendingRedeemOwners;
        VaultTypes.ActiveOracleRequest activeOracleRequest;
        uint256 settlementAllowedAt;
        uint64 lastFeeAccrualAt;
        bool isInvalidPrice;
        uint256 highWaterMark;
        uint256 lastTokenPrice;
    }

    function data() internal pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
