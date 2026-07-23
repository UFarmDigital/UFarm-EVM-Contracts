// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

error Unauthorized(address caller);
error InvalidAddress();
error InvalidMetadata();
error InvalidAsset();
error CuratorNotRegistered(address curator);
error VaultNotRegistered(address vault);
error CoreConfigError(uint8 reason);
