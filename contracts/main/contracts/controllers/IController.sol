// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/**
 * @title Controller Interface
 * @author https://ufarm.digital/
 * @dev Interface for the Controller contract in the UFarm ecosystem.
 * Provides protocol-level controls for pools.
 */
interface IController {
	/**
	 * @dev Returns the protocol identifier.
	 * @return bytes32 The protocol identifier.
	 */
	function PROTOCOL() external view returns (bytes32);
}

interface IERC20CommonController is IController {}

interface IERC20SynthController is IController {
	/**
	 * @dev Calculates the cost for a ERC20 token in terms of a value token.
	 * @param _tokenIn - token address to calculate the cost for.
	 * @param _amountIn - array of amounts of tokens to calculate the cost for.
	 * @param _valueToken - the address of the value token to calculate the cost in.
	 * @return cost - calculated cost in the value token.
	 */
	function getCostControlledERC20(
		address _tokenIn,
		uint256 _amountIn,
		address _valueToken
	) external view returns (uint256 cost);

	/**
	 * @notice Encodes data for a partial withdrawal from a Uniswap V2 liquidity pool
	 * @param _token - The address of the LP (liquidity provider) token
	 * @param _numerator - The numerator of the fraction of the position to withdraw, user balance in common
	 * @param _denominator - The denominator of the fraction of the position to withdraw, ufarmPool total supply
	 * @return encodedTxs - Encoded transactions array
	 */
	function encodePartialWithdrawalERC20(
		address _token,
		uint256 _numerator,
		uint256 _denominator
	) external view returns (bytes[] memory encodedTxs);
}

/**
 * @title ERC721 Controller Interface
 * @dev Interface for the ERC721 Controller in the UFarm ecosystem.
 * Provides specialized controls for ERC721 tokens within pools.
 */
interface IERC721Controller is IController {
	/**
	 * @dev Calculates the cost for a set of ERC721 tokens in terms of a value token.
	 * @param _lpAddr The address of the liquidity pool.
	 * @param _ids Array of token IDs to calculate the cost for.
	 * @param _valueToken The address of the value token to calculate the cost in.
	 * @return cost The calculated cost in the value token.
	 */
	function getCostControlledERC721(
		address _lpAddr,
		uint256[] memory _ids,
		address _valueToken
	) external view returns (uint256 cost);

	/**
	 * @notice Encodes data for a partial withdrawal from a Uniswap V3 liquidity pool
	 * @param _tokenId - The ID of the Uniswap V3 LP (liquidity provider) NFT
	 * @param _numerator - The numerator of the fraction of the position to withdraw
	 * @param _denominator - The denominator of the fraction of the position to withdraw
	 * @return withdrawalTxs - The encoded transactions data for the partial withdrawal
	 */
	function encodePartialWithdrawalERC721(
		address _tokenAddress,
		uint256 _tokenId,
		uint256 _numerator,
		uint256 _denominator
	) external view returns (bytes[] memory withdrawalTxs);
}
