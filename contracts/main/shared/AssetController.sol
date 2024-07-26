// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';

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

library AssetLib {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	uint256 internal constant COMMON_ERC20_WEIGHT = 1;
	uint256 internal constant CONTROLLED_ERC20_WEIGHT = 2;
	uint256 internal constant CONTROLLED_ERC721_WEIGHT = 5;

	/**
	 * @notice Returns the list of all ERC20 assets
	 * @param _self - Assets struct
	 */
	function erc20CommonAssets(
		AssetsStructs.Assets storage _self
	) internal view returns (address[] memory tokenAssets) {
		return _self.erc20.assets.values();
	}

	function erc20ControlledAssets(
		AssetsStructs.Assets storage _self
	) internal view returns (AssetsStructs.ControlledERC20[] memory liquidityAssetsERC20) {
		AssetsStructs.ERC20ControlledAssets storage controlledERC20 = _self.erc20Controlled;
		uint256 assetsLength = controlledERC20.assets.length();
		liquidityAssetsERC20 = new AssetsStructs.ControlledERC20[](assetsLength);
		address asset;
		for (uint256 i; i < assetsLength; ++i) {
			asset = controlledERC20.assets.at(i);
			liquidityAssetsERC20[i] = AssetsStructs.ControlledERC20({
				addr: asset,
				controller: controlledERC20.controllers[asset]
			});
		}
	}

	function erc721ControlledAssets(
		AssetsStructs.Assets storage _self
	) internal view returns (AssetsStructs.ControlledERC721[] memory liquidityAssetsERC721) {
		AssetsStructs.ERC721ControlledAssets storage controlledERC721 = _self.erc721Controlled;
		uint256 assetsLength = controlledERC721.assets.length();
		liquidityAssetsERC721 = new AssetsStructs.ControlledERC721[](assetsLength);
		address asset;
		for (uint256 i; i < assetsLength; ++i) {
			asset = controlledERC721.assets.at(i);
			liquidityAssetsERC721[i] = AssetsStructs.ControlledERC721({
				addr: asset,
				controller: controlledERC721.controllers[asset],
				ids: controlledERC721.idsOfAsset[asset].values()
			});
		}
	}

	function addERC20(
		AssetsStructs.Assets storage _self,
		address _asset,
		bytes32 _controller
	) internal {
		if (_controller > bytes32(0)) {
			// return if asset already added to controlled list
			if (_self.erc20.assets.contains(_asset)) return;

			// add if balance > 0 and not added yet
			if (
				!_self.erc20Controlled.assets.contains(_asset) &&
				IERC20(_asset).balanceOf(address(this)) > 0
			) {
				_self.erc20Controlled.assets.add(_asset);
				_self.erc20Controlled.controllers[_asset] = _controller;
				_self.totalWeight += CONTROLLED_ERC20_WEIGHT;
			}
		} else {
			// return if asset already added to controlled assets list
			if (_self.erc20Controlled.assets.contains(_asset)) return;

			// add if balance > 0 and not added yet
			if (!_self.erc20.assets.contains(_asset) && IERC20(_asset).balanceOf(address(this)) > 0) {
				_self.erc20.assets.add(_asset);
				_self.totalWeight += COMMON_ERC20_WEIGHT;
			}
		}
	}

	function removeERC20(AssetsStructs.Assets storage _self, address _asset) internal {
		if (IERC20(_asset).balanceOf(address(this)) == 0) {
			// removes asset if balance is 0
			if (_self.erc20.assets.remove(_asset)) {
				_self.totalWeight -= COMMON_ERC20_WEIGHT;
			} else if (_self.erc20Controlled.assets.remove(_asset)) {
				delete _self.erc20Controlled.controllers[_asset];
				_self.totalWeight -= CONTROLLED_ERC20_WEIGHT;
			}
		}
	}

	function addERC721WithController(
		AssetsStructs.Assets storage _self,
		address _asset,
		uint256[] memory _ids,
		bytes32 _controller
	) internal {
		uint256 idsLength = _ids.length;
		if (idsLength == 0 || IERC721(_asset).balanceOf(address(this)) == 0) return;

		AssetsStructs.ERC721ControlledAssets storage erc721Controlled = _self.erc721Controlled;

		bool atLeastOneAdded; // false by default
		for (uint256 i; i < idsLength; ++i) {
			if (
				_checkERC721Ownership(_asset, _ids[i]) && erc721Controlled.idsOfAsset[_asset].add(_ids[i])
			) {
				_self.totalWeight += CONTROLLED_ERC721_WEIGHT;
				if (!atLeastOneAdded) {
					atLeastOneAdded = true;
				}
			} else continue;
		}

		if (atLeastOneAdded && !erc721Controlled.assets.contains(_asset)) {
			erc721Controlled.assets.add(_asset);
			erc721Controlled.controllers[_asset] = _controller;
		}
	}

	function removeERC721WithController(
		AssetsStructs.Assets storage _self,
		address _asset,
		uint256[] memory _ids
	) internal {
		uint256 toRemove;
		AssetsStructs.ERC721ControlledAssets storage erc721Controlled = _self.erc721Controlled;
		for (uint256 i; i < _ids.length; ++i) {
			// skip if pool still owns this token
			if (_checkERC721Ownership(_asset, _ids[i])) continue;
			erc721Controlled.idsOfAsset[_asset].remove(_ids[i]);
			toRemove++;
		}
		if (IERC721(_asset).balanceOf(address(this)) == 0) {
			erc721Controlled.assets.remove(_asset);
			delete erc721Controlled.controllers[_asset];
			toRemove += erc721Controlled.idsOfAsset[_asset].length();
			delete erc721Controlled.idsOfAsset[_asset];
		}
		_self.totalWeight -= toRemove * CONTROLLED_ERC721_WEIGHT;
	}

	/// solhint-disable-next-line no-unassigned-vars
	function _checkERC721Ownership(address _asset, uint256 _id) private view returns (bool) {
		// doesn't crash when token isn't exists
		try IERC721(_asset).ownerOf(_id) returns (address owner) {
			return owner == address(this);
		} catch {
			return false;
		}
	}
}
