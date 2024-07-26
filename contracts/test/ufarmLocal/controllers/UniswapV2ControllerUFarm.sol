// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {UnoswapV2Controller} from '../../../main/contracts/controllers/UnoswapV2Controller.sol';

contract UniswapV2ControllerUFarm is UnoswapV2Controller {
	bytes32 private constant _PROTOCOL = keccak256(abi.encodePacked('UniswapV2'));

	/**
	 * @notice UnoswapV2Controller constructor
	 * @param _factory - address of the UnoswapV2 factory
	 * @param _router - address of the UnoswapV2 router
	 * @param _priceOracle - address of the PriceOracle
	 * @param _factoryInitCodeHash - init code hash of the UnoswapV2 factory
	 */
	constructor(
		address _factory,
		address _router,
		address _priceOracle,
		bytes32 _factoryInitCodeHash
	) UnoswapV2Controller(_factory, _router, _priceOracle, _factoryInitCodeHash) {}

	function PROTOCOL() public pure override returns (bytes32) {
		return _PROTOCOL;
	}
}
