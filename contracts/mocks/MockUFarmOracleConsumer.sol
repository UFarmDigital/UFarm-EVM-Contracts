// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmOracle} from "../interfaces/IUFarmOracle.sol";
import {IUFarmOracleConsumer} from "../interfaces/IUFarmOracleConsumer.sol";

contract MockUFarmOracleConsumer is IUFarmOracleConsumer {
    error MockConsumerRejected();

    uint256 public lastRequestId;
    uint256 public lastNav;
    uint64 public lastValuationTimestamp;
    address public lastCaller;
    bool public shouldReject;

    function requestNav(address oracle) external returns (uint256) {
        return IUFarmOracle(oracle).requestNav(address(this));
    }

    function setShouldReject(bool shouldReject_) external {
        shouldReject = shouldReject_;
    }

    function onOracleNav(uint256 oracleRequestId, uint256 nav, uint64 valuationTimestamp) external {
        if (shouldReject) revert MockConsumerRejected();
        lastCaller = msg.sender;
        lastRequestId = oracleRequestId;
        lastNav = nav;
        lastValuationTimestamp = valuationTimestamp;
    }
}
