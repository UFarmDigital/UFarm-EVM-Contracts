// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {IChainlinkAggregator} from '../oracle/IChainlinkAggregator.sol';
import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';

/**
 * @title ChainlinkedOracle contract
 * @author https://ufarm.digital/
 * @notice Calls Chainlink Aggregator contracts and checks for stale data
 */
abstract contract ChainlinkedOracle is Initializable {
	struct ChainlinkAnswer {
		uint80 roundId;
		int256 answer;
		uint256 startedAt;
		uint256 updatedAt;
		uint80 answeredInRound;
	}
	uint256 constant HOUR = 3600;

	uint256 public chainlinkTimeout;

	event ChainlinkTimeoutSet(uint256 timeout);

	error WrongChainlinkPrice(address oracle);
	error IncompleteChainlinkRound(address oracle);
	error StaleChainlinkPrice(address oracle);
	error ChainlinkOracleOutdated(address oracle);
	error ChainlinkOracleNotSet(address asset);
	error ChainlinkOracleIsDown(address oracle);

	function __init__ChainlinkedOracle(uint256 _chainlinkTimeout) internal virtual onlyInitializing {
		__init__ChainlinkedOracle_unchained(_chainlinkTimeout);
	}

	function __init__ChainlinkedOracle_unchained(
		uint256 _chainlinkTimeout
	) internal virtual onlyInitializing {
		chainlinkTimeout = _chainlinkTimeout;
		emit ChainlinkTimeoutSet(_chainlinkTimeout);
	}

	function _chainlinkLatestRoundData(
		address _oracle
	) internal view returns (ChainlinkAnswer memory latestRoundData) {
		try IChainlinkAggregator(_oracle).latestRoundData() returns (
			uint80 roundId,
			int256 answer,
			uint256 startedAt,
			uint256 updatedAt,
			uint80 answeredInRound
		) {
			if (answer < 1) revert WrongChainlinkPrice(_oracle);
			if (updatedAt == 0) revert IncompleteChainlinkRound(_oracle);
			if (roundId < answeredInRound) revert StaleChainlinkPrice(_oracle);
			if ((updatedAt + chainlinkTimeout) < block.timestamp) revert ChainlinkOracleOutdated(_oracle);

			return ChainlinkAnswer(roundId, answer, startedAt, updatedAt, answeredInRound);
		} catch {
			revert ChainlinkOracleIsDown(_oracle);
		}
	}

	function _chainlinkLatestAnswer(address _oracle) internal view returns (int256 answer) {
		return _chainlinkLatestRoundData(_oracle).answer;
	}

	uint256[50] private __gap;
}
