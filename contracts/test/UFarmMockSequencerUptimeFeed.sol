// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

contract UFarmMockSequencerUptimeFeed {
	/// @dev Packed state struct to save sloads
	struct FeedState {
		uint80 latestRoundId;
		bool latestStatus;
		uint64 latestTimestamp;
	}
	
	uint80 public latestRoundId;
	int256 public _answer;

	FeedState private s_feedState =
		FeedState({latestRoundId: 0, latestStatus: false, latestTimestamp: 0});

	function setLatestRoundData(int256 answer) external {
		_answer = answer;

		latestRoundId += 1;
		s_feedState.latestTimestamp = uint64(block.timestamp);
	}

	function latestRoundData()
		external
		view
		returns (
			uint80 roundId,
			int256 answer,
			uint256 startedAt,
			uint256 updatedAt,
			uint80 answeredInRound
		)
	{
		FeedState memory feedState = s_feedState;

		roundId = feedState.latestRoundId;
		startedAt = feedState.latestTimestamp;
		updatedAt = startedAt;
		answeredInRound = roundId;
		answer = _answer;
	}
}
