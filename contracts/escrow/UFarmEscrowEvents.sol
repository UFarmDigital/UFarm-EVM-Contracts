// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

event EscrowCredited(
    address indexed vault, address indexed asset, address indexed beneficiary, uint256 amount, uint64 lockedTill
);
event EscrowReleased(
    address indexed vault, address indexed asset, address indexed beneficiary, address to, uint256 amount
);
event EscrowUnlocked(address indexed vault, address indexed asset, address indexed beneficiary, uint256 amount);
event EscrowWithdrawn(
    address indexed vault, address indexed asset, address indexed beneficiary, address to, uint256 amount
);
