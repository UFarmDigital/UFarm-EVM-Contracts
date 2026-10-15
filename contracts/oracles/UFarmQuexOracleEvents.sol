// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

event QuexActionDataUpdated(uint256 indexed flowVersion);
event QuexFlowCacheInvalidated(uint256 indexed flowVersion);
event QuexFlowCreated(address indexed vault, uint256 indexed flowId, uint256 indexed flowVersion);
event QuexRequestCreated(address indexed vault, uint256 indexed requestId);
