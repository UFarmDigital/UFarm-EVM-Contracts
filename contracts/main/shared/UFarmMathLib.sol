// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.15;

/**
 * @title UFarmMathLib
 * @dev Library for mathematical calculations used in UFarm contracts.
 */
library UFarmMathLib {
	/**
	 * @notice Converts an amount from one decimal format to another.
	 * @param amount The amount to be converted.
	 * @param fromDecimals The current decimal representation of the amount.
	 * @param toDecimals The target decimal representation.
	 * @return The amount converted to the target decimal format.
	 */
	function convertDecimals(
		int256 amount,
		uint8 fromDecimals,
		uint8 toDecimals
	) internal pure returns (int256) {
		if (fromDecimals > toDecimals) {
			return amount / int256(10 ** (fromDecimals - toDecimals));
		} else if (fromDecimals < toDecimals) {
			return amount * int256(10 ** (toDecimals - fromDecimals));
		}
		return amount;
	}

	/**
	 * @notice Calculates the square root of a given number.
	 * implementation from https://github.com/Uniswap/uniswap-lib/commit/99f3f28770640ba1bb1ff460ac7c5292fb8291a0
	 * original implementation: https://github.com/abdk-consulting/abdk-libraries-solidity/blob/master/ABDKMath64x64.sol#L687
	 * @param x - uint256
	 */
	function sqrt(uint256 x) internal pure returns (uint256) {
		if (x == 0) return 0;
		uint256 xx = x;
		uint256 r = 1;

		if (xx >= 0x100000000000000000000000000000000) {
			xx >>= 128;
			r <<= 64;
		}

		if (xx >= 0x10000000000000000) {
			xx >>= 64;
			r <<= 32;
		}
		if (xx >= 0x100000000) {
			xx >>= 32;
			r <<= 16;
		}
		if (xx >= 0x10000) {
			xx >>= 16;
			r <<= 8;
		}
		if (xx >= 0x100) {
			xx >>= 8;
			r <<= 4;
		}
		if (xx >= 0x10) {
			xx >>= 4;
			r <<= 2;
		}
		if (xx >= 0x8) {
			r <<= 1;
		}

		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1;
		r = (r + x / r) >> 1; // Seven iterations should be enough
		uint256 r1 = x / r;
		return (r < r1 ? r : r1);
	}
}
