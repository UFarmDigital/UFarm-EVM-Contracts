// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {PriceOracleCore} from '../../../main/contracts/oracle/PriceOracleCore.sol';
import {AggregatorV3Interface} from '@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol';

contract PriceOracleArbitrum is PriceOracleCore {
	AggregatorV3Interface public sequencerUptimeFeed;

	uint256 private constant GRACE_PERIOD_TIME = 3600; // 1 hour in seconds

	event SequencerUptimeFeedSet(address indexed sequencerUptimeFeed);

	error SequencerDown();
	error GracePeriodNotOver();

	function getCostERC20(
		address tokenIn,
		uint256 amountIn,
		address tokenOut
	) public view override returns (uint256 cost) {
		// Check for awailability of the sequencer uptime feed on Arbitrum
		(, int256 answer, uint256 startedAt, , ) = sequencerUptimeFeed.latestRoundData();

		if (answer != 0) {
			revert SequencerDown();
		}

		if ((block.timestamp - startedAt) < GRACE_PERIOD_TIME) {
			revert GracePeriodNotOver();
		}

		return super.getCostERC20(tokenIn, amountIn, tokenOut);
	}

	function __init__PriceOracleArbitrum(
		address ufarmCoreLink,
		address _sequencerUptimeFeed
	) external onlyDeployer initializer {
		__init__PriceOracleCore(ufarmCoreLink);
		__init__PriceOracleArbitrum_unchained(_sequencerUptimeFeed);
	}

	function __init__PriceOracleArbitrum_unchained(
		address _sequencerUptimeFeed
	) internal onlyInitializing {
		sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);
		emit SequencerUptimeFeedSet(address(sequencerUptimeFeed));
	}
}
