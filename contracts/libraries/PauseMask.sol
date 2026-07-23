// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library PauseMask {
    uint256 internal constant NONE = 0;
    uint256 internal constant FULL_PROTOCOL_PAUSE = 1 << 0;
    uint256 internal constant DEPOSIT_REQUESTS_PAUSED = 1 << 1;
    uint256 internal constant REDEEM_REQUESTS_PAUSED = 1 << 2;
    uint256 internal constant CLAIMS_PAUSED = 1 << 3;
    uint256 internal constant CANCELS_PAUSED = 1 << 4;
    uint256 internal constant ORACLE_REQUESTS_PAUSED = 1 << 5;
    uint256 internal constant ORACLE_CALLBACKS_PAUSED = 1 << 6;
    uint256 internal constant ADAPTER_EXECUTION_PAUSED = 1 << 7;
    uint256 internal constant CROSS_CHAIN_OPERATIONS_PAUSED = 1 << 8;
    uint256 internal constant SHARE_TRANSFERS_PAUSED = 1 << 9;
    uint256 internal constant ESCROW_OPERATIONS_PAUSED = 1 << 10;

    function isPaused(uint256 mask, uint256 bit) internal pure returns (bool) {
        return mask & bit != 0;
    }
}
