// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

interface AssetsStructs {
	struct ControlledERC20 {
		address addr;
		bytes32 controller;
	}

	struct ControlledERC721 {
		address addr;
		bytes32 controller;
		uint256[] ids;
	}

	struct Assets {
		uint256 totalWeight;
		ERC20CommonAssets erc20;
		ERC20ControlledAssets erc20Controlled;
		ERC721ControlledAssets erc721Controlled;
	}
	struct ERC20CommonAssets {
		EnumerableSet.AddressSet assets;
	}
	struct ERC20ControlledAssets {
		EnumerableSet.AddressSet assets;
		mapping(address => bytes32) controllers;
	}
	struct ERC721ControlledAssets {
		EnumerableSet.AddressSet assets;
		mapping(address => EnumerableSet.UintSet) idsOfAsset;
		mapping(address => bytes32) controllers;
	}
}
