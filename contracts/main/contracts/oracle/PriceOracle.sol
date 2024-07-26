// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {PriceOracleCore} from './PriceOracleCore.sol';

/**
 * @title PriceOracle
 * @author https://ufarm.digital/
 * @notice  Calculates the cost of the pool and tokens
 */
contract PriceOracle is PriceOracleCore {
	/**
	 * @notice Initializes the contract from deployer. Sets link to UFarmCore
	 * @param ufarmCoreLink - address of the core contract
	 */
	function __init__PriceOracle(address ufarmCoreLink) external onlyDeployer initializer {
		__init__PriceOracleCore(ufarmCoreLink);
	}
}
