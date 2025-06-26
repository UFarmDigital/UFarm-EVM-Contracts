// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

interface IChainlinkAggregator {
    function latestAnswer() external view returns (int256);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}
