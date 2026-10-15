// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

event QuexBatchConfigUpdated(address indexed requestOraclePool, uint96 gasLimit);
event QuexBatchActionDataUpdated(address indexed vault, uint256 indexed actionId, uint256 flowVersion);
event QuexVaultFlowCacheInvalidated(address indexed vault, uint256 flowVersion);
event QuexFlowCreated(address indexed vault, uint256 indexed flowId, uint256 indexed flowVersion);
event QuexRequestCreated(address indexed vault, uint256 indexed requestId);
