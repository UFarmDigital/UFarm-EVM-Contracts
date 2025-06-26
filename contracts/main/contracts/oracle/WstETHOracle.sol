// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {ChainlinkedOracle} from "./ChainlinkedOracle.sol";
import {IChainlinkAggregator} from "./IChainlinkAggregator.sol";

/**
 * @title WstETHOracle contract
 * @author https://ufarm.digital/
 * @notice Wraps the stETH/USD and wstETH/stETH Chainlink price feeds to query the wstETH/USD price
 */
contract WstETHOracle is IChainlinkAggregator, ChainlinkedOracle {
    uint8 public immutable decimals;

    address public immutable stETHUSDOracle;
    address public immutable wstETHstETHOracle;
    address public immutable wstETH;

    constructor(address _wstETH, address _stETHUSDOracle, address _wstETHstETHOracle) initializer {
        __init__ChainlinkedOracle(HOUR * 25);
        stETHUSDOracle = _stETHUSDOracle;
        wstETHstETHOracle = _wstETHstETHOracle;
        wstETH = _wstETH;
        decimals = IChainlinkAggregator(_stETHUSDOracle).decimals();
    }

    function latestAnswer() external view override returns (int256 answer) {
        answer = _stETHtoWstETH(_chainlinkLatestAnswer(stETHUSDOracle));
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        ChainlinkAnswer memory stETHRoundData = _chainlinkLatestRoundData(stETHUSDOracle);
        answer = _stETHtoWstETH(stETHRoundData.answer);
        return (
            stETHRoundData.roundId,
            answer,
            stETHRoundData.startedAt,
            stETHRoundData.updatedAt,
            stETHRoundData.answeredInRound
        );
    }

    function description() external pure returns (string memory) {
        return "UFarm WstETH/USD Oracle";
    }

    function _stETHtoWstETH(int256 _stETHUSDPrice) internal view returns (int256 wstETHUSDPrice) {
        wstETHUSDPrice = _chainlinkLatestAnswer(wstETHstETHOracle);

        return (wstETHUSDPrice * _stETHUSDPrice) / 10 ** 18;
    }
}
