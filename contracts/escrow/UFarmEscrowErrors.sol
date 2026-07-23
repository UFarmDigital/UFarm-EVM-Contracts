// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

error Unauthorized(address caller);
error InvalidAddress();
error InvalidAmount();
error InsufficientLiquidity();
error AssetLocked(uint64 lockedTill);
