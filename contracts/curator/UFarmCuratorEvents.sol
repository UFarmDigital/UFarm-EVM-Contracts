// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

event VaultCreated(address indexed curator, address indexed owner, bytes32 indexed logicalSalt, address vault);
event CuratorPermissionUpdated(address indexed account, uint256 newMask);
