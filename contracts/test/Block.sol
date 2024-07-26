// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

contract Block {
	uint256 blockNumber;

	function setBlockNumber(uint256 _blockNumber) public {
		blockNumber = _blockNumber;
	}

    function getBlockTimestamp() public view returns (uint256) {
        return block.timestamp;
    }
}
