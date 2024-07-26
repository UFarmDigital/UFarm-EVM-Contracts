// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {IController} from '../../../main/contracts/controllers/IController.sol';
import {UnoswapV3Controller} from '../../../main/contracts/controllers/UnoswapV3Controller.sol';
import {Controller} from '../../../main/contracts/controllers/Controller.sol';

contract UniswapV3ControllerUFarm is UnoswapV3Controller {
	bytes32 private constant _PROTOCOL = keccak256(abi.encodePacked('UniswapV3'));

	/**
	 * @notice UnoswapV3Controller constructor
	 * @param _swapRouter - address of the Uniswap SwapRouter
	 * @param _swapFactory - address of the UniswapV3 factory
	 * @param _nfpm - address of the UniswapV3 NonfungiblePositionManager
	 * @param _priceOracle - address of the PriceOracle
	 * @param _initHash - init code hash of the UniswapV3 factory
	 */
	constructor(
		address _swapRouter,
		address _swapFactory,
		address _nfpm,
		address _priceOracle,
		bytes32 _initHash
	)
		UnoswapV3Controller(
			_swapRouter,
			_swapFactory,
			_nfpm,
			_priceOracle,
			_initHash
		)
	{}

	function PROTOCOL() public pure override(IController, Controller) returns (bytes32) {
		return _PROTOCOL;
	}

	function TWAP_PERIOD() public pure override returns (uint32) {
		return 1800; // 30 minutes
	}
}
