// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;
import {OwnableUpgradeable} from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';

contract UUPSBlock is UUPSUpgradeable, OwnableUpgradeable {
	uint256 blockNumber;

	function setBlockNumber(uint256 _blockNumber) public {
		blockNumber = _blockNumber;
	}

	function getBlockTimestamp() public view returns (uint256) {
		return block.timestamp;
	}

	function _authorizeUpgrade(address) internal override {}
}
