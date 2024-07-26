// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {AggregatorV2V3Interface} from '@chainlink/contracts/src/v0.8/interfaces/AggregatorV2V3Interface.sol';
import {IUniswapV2Router02} from './Uniswap/contracts/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol';
import {ERC20} from '@oldzeppelin/contracts/token/ERC20/ERC20.sol';
import {UFarmMathLib} from '../main/shared/UFarmMathLib.sol';
import {IWstETH8, IStETH8} from '../test/lido/contracts/IWstETH8.sol';

/**
 * @title MockV3wstETHstETHAgg
 * @notice Based on the @chainlink/contracts/src/v0.8/tests/MockV3Aggregator.sol
 */
contract MockV3wstETHstETHAgg is AggregatorV2V3Interface {
	uint256 public constant override version = 0;

	uint8 public immutable override decimals;
	IStETH8 public immutable stETH;
	IWstETH8 public immutable wstETH;

	int256 public override latestAnswer;
	uint256 public override latestTimestamp;
	uint256 public override latestRound;

	mapping(uint256 => int256) public override getAnswer;
	mapping(uint256 => uint256) public override getTimestamp;
	mapping(uint256 => uint256) private getStartedAt;

	constructor(IWstETH8 _wstETH) {
		decimals = 18;
		wstETH = _wstETH;
		stETH = IStETH8(_wstETH.stETH());
		updateAnswer(getChainlinkFormattedPrice());
	}

	function getChainlinkFormattedPrice() public view returns (int256 chainlinkPrice) {
		return int256(wstETH.stEthPerToken());
	}

	function _answerStETHToWstETH(int256 _stETHPrice) internal view returns (int256) {
		int256 wstETH_stETHPrice = int256(wstETH.stEthPerToken());
		return (_stETHPrice * wstETH_stETHPrice) / 10 ** 18;
	}

	function updateAnswerWithChainlinkPrice() public {
		updateAnswer(getChainlinkFormattedPrice());
	}

	function updateAnswer(int256 _answer) public {
		latestAnswer = _answer;
		latestTimestamp = block.timestamp;
		latestRound++;
		getAnswer[latestRound] = _answer;
		getTimestamp[latestRound] = block.timestamp;
		getStartedAt[latestRound] = block.timestamp;
	}

	function updateRoundData(
		uint80 _roundId,
		int256 _answer,
		uint256 _timestamp,
		uint256 _startedAt
	) public {
		latestRound = _roundId;
		latestAnswer = _answer;
		latestTimestamp = _timestamp;
		getAnswer[latestRound] = _answer;
		getTimestamp[latestRound] = _timestamp;
		getStartedAt[latestRound] = _startedAt;
	}

	function getRoundData(
		uint80 _roundId
	)
		external
		view
		override
		returns (
			uint80 roundId,
			int256 answer,
			uint256 startedAt,
			uint256 updatedAt,
			uint80 answeredInRound
		)
	{
		return (
			_roundId,
			getAnswer[_roundId],
			getStartedAt[_roundId],
			getTimestamp[_roundId],
			_roundId
		);
	}

	function latestRoundData()
		external
		view
		override
		returns (
			uint80 roundId,
			int256 answer,
			uint256 startedAt,
			uint256 updatedAt,
			uint80 answeredInRound
		)
	{
		answer = getChainlinkFormattedPrice();
		uint80 updateTime = uint80(block.timestamp - 600);
		// return (
		// 	uint80(latestRound),
		// 	getAnswer[latestRound],
		// 	getStartedAt[latestRound],
		// 	getTimestamp[latestRound],
		// 	uint80(latestRound)
		// );
		return (
			uint80(block.timestamp),
			answer,
			getStartedAt[latestRound],
			updateTime,
			uint80(latestRound)
		);
	}

	function description() external pure override returns (string memory) {
		return 'v0.8/tests/MockV3Aggregator.sol';
	}
}
