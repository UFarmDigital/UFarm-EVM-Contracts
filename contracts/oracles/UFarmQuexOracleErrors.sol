// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

error Unauthorized(address caller);
error InvalidAddress();
error InvalidConfig();
error OracleFlowError(uint8 reason);
error QuexResponseError(uint256 code);
