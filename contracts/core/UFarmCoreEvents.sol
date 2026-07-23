// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

event PermissionUpdated(address indexed account, uint256 newMask);
event GlobalPauseMaskUpdated(uint256 newMask);
event CuratorPauseMaskUpdated(address indexed curator, uint256 newMask);
event ValueTokenUpdated(address indexed asset, bool configured);
event VaultOracleUpdated(address indexed vault, address indexed oracle);
event ProtocolFeeUpdated(address indexed vaultAddress, uint256 protocolFee, bool zeroUFarmFee, bool configured);
event VaultAdapterUpdated(bytes32 indexed adapterId, address indexed vault, address indexed adapter);
event VaultModuleUpdated(bytes32 indexed moduleId, address indexed newModule);
event CoreParameterUpdated(bytes32 indexed parameter, uint256 newValue);
event CuratorCreated(address indexed owner, bytes32 indexed logicalSalt, address indexed curator);
event CCIPSelectorUpdated(uint64 indexed chainId, uint64 newSelector);
