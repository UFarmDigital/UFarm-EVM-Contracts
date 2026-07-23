// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmOracleConsumer {
    function onOracleNav(uint256 oracleRequestId, uint256 nav, uint64 valuationTimestamp) external;
}
