// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IAggregatorV3} from "../interfaces/chainlink/IAggregatorV3.sol";

contract MockChainlinkAggregator is IAggregatorV3 {
    uint8 public immutable override decimals;

    int256 private _answer;
    uint256 private _updatedAt;
    bool private _shouldRevert;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        _answer = answer_;
        _updatedAt = block.timestamp;
    }

    function setRoundData(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        _shouldRevert = shouldRevert_;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (_shouldRevert) {
            revert();
        }

        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}
