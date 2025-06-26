// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.24;

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
