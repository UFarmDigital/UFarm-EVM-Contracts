// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmVaultOracleEvents} from "../vault/UFarmVaultEvents.sol";

interface IUFarmVaultOracle is IUFarmVaultOracleEvents {
    function settleRequests() external returns (uint256 oracleRequestId);
    function onOracleNav(uint256 oracleRequestId, uint256 nav, uint64 valuationTimestamp) external;
    function resetRequests() external;
    function manualResendOracleRequest() external returns (uint256 newOracleRequestId);
    function resetInvalidPrice(uint256 acceptedNav) external;
    function activeOracleRequestId() external view returns (uint256);
    function settlementAllowedAt() external view returns (uint256);
    function lastTokenPrice() external view returns (uint256);
    function isInvalidPrice() external view returns (bool);
}
