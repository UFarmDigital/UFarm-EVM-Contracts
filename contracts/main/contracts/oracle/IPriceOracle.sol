// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

interface IPriceOracle {
	/**
	 * @notice Returns total cost of the pool in terms of value token
	 * @param ufarmPool - address of the pool
	 * @param valueToken - address of the token in which the cost is calculated
	 */
	function getTotalCostOfPool(
		address ufarmPool,
		address valueToken
	) external view returns (uint256 totalCost);

	/**
	 * @notice Returns cost of the token in terms of value token
	 * @param tokenIn - address of the token which cost will be calculated
	 * @param amountIn - amount of the token which cost will be calculated
	 * @param tokenOut - address of the token in which the cost is calculated
	 */
	function getCostERC20(
		address tokenIn,
		uint256 amountIn,
		address tokenOut
	) external view returns (uint256 cost);

	/**
	 * @notice Returns cost of the token in terms of value token
	 * @param tokenIn - address of the token which cost will be calculated
	 * @param amountIn - amount of the token which cost will be calculated
	 * @param tokenOut - address of the token in which the cost is calculated
	 * @param controller - address of the controller, which will be used to calculate the cost
	 */
	function getCostControlledERC20(
		address tokenIn,
		uint256 amountIn,
		address tokenOut,
		address controller
	) external view returns (uint256 cost);

	/**
	 * @notice Returns cost of the token in terms of value token
	 * @param tokenIn - address of the token which cost will be calculated
	 * @param ids - ids of the token which cost will be calculated
	 * @param tokenOut - address of the token in which the cost is calculated
	 * @param controller - address of the controller, which will be used to calculate the cost
	 */
	function getCostERC721(
		address tokenIn,
		uint256[] memory ids,
		address tokenOut,
		address controller
	) external view returns (uint256 cost);
}
