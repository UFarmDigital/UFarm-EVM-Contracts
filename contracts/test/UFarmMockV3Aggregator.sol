// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import '@chainlink/contracts/src/v0.8/interfaces/AggregatorV2V3Interface.sol';
import {IUniswapV2Router02} from './Uniswap/contracts/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol';
import {ERC20} from '@oldzeppelin/contracts/token/ERC20/ERC20.sol';
import {UFarmMathLib} from '../main/shared/UFarmMathLib.sol';

/**
 * @title MockV3Aggregator
 * @notice Based on the @chainlink/contracts/src/v0.8/tests/MockV3Aggregator.sol
 * @notice Use this contract when you need to test
 * other contract's ability to read data from an
 * aggregator contract, but how the aggregator got
 * its answer is unimportant
 */
contract UFarmMockV3Aggregator is AggregatorV2V3Interface {
	uint256 public constant override version = 0;

	uint8 public override decimals;
	int256 public override latestAnswer;
	uint256 public override latestTimestamp;
	uint256 public override latestRound;

	mapping(uint256 => int256) public override getAnswer;
	mapping(uint256 => uint256) public override getTimestamp;
	mapping(uint256 => uint256) private getStartedAt;

	IUniswapV2Router02 public router;
	address[] public path = new address[](2);
	uint8 public tokenQuoteDecimals;
	uint8 public tokenBaseDecimals;

	constructor(
		uint8 _decimals,
		IUniswapV2Router02 _router,
		address _tokenBase, // tokenIn
		address _tokenQuote // tokenOut
	) {
		decimals = _decimals;
		router = _router;
		path[0] = _tokenBase;
		path[1] = _tokenQuote;
		tokenBaseDecimals = ERC20(_tokenBase).decimals();
		tokenQuoteDecimals = ERC20(_tokenQuote).decimals();
		updateAnswer(getChainlinkFormattedPrice());
	}

	function getChainlinkFormattedPrice() public view returns (int256 chainlinkPrice) {
		if (path[0] == path[1]) return int256(10 ** decimals);
		// Fetching the price from Uniswap

		// get cost of 1 tokenQuote in tokenBase
		uint256 tokenAmount = 10 ** tokenBaseDecimals;
		uint256[] memory amounts = router.getAmountsOut(tokenAmount, path);
		chainlinkPrice = int256(
			UFarmMathLib.convertDecimals(int256(amounts[1]), tokenQuoteDecimals, decimals)
		);
		return chainlinkPrice;
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
