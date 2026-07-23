// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmOracle {
    function requestNav(address vault) external returns (uint256 oracleRequestId);
}
