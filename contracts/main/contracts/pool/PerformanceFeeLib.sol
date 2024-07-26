// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// INTERFACES
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IPoolAdmin} from '../pool/IPoolAdmin.sol';

/// CONTRACTS
import {UFarmCoreLink} from '../../shared/UFarmCoreLink.sol';
import {NZGuard} from '../../shared/NZGuard.sol';

library PerformanceFeeLib {
	uint16 internal constant MAX_COMMISSION_STEP = type(uint16).max;
	uint16 internal constant ONE_HUNDRED_PERCENT = 10000;
	/**
	 * @notice Reverts if fee steps count is invalid
	 */
	error InvalidPerformanceCommissionStepsCount();

	/**
	 * @notice Reverts if step is invalid
	 */
	error InvalidPerformanceCommissionStep(uint16 step, uint16 fee);

	function _getPerformanceCommission(
		uint256 packedPerformanceFee,
		uint16 apyRate
	) internal pure returns (uint16 commission) {
		if (apyRate == 0 || packedPerformanceFee == 0) return 0;
		
		uint8 filledLength = _getPerformanceCommissionStepsCount(packedPerformanceFee);
		IUFarmPool.PerformanceCommissionStep memory pfs;
		for (uint8 i; i < filledLength; ++i) {
			pfs = _getPerformanceCommissionStep(packedPerformanceFee, i);
			if (apyRate > pfs.step) commission = pfs.commission;
			else break;
		}

		return commission;
	}

	function _getPerformanceCommissionStepsCount(
		uint256 packedPerformanceFee
	) internal pure returns (uint8 filledLength) {
		assembly {
			// Initialize filledLength to 0
			filledLength := 0

			// Load the packedPerformanceFee value into a temporary variable
			let temp := packedPerformanceFee

			// Iterate through the packedPerformanceFee value
			for {

			} gt(temp, 0) {

			} {
				// Increment filledLength by 1
				filledLength := add(filledLength, 1)

				// Right shift the temporary variable by 32 bits
				temp := shr(32, temp)
			}
		}
	}

	function _getPerformanceCommissionStep(
		uint256 packedPerformanceCommissionStep,
		uint8 stepNumber
	) internal pure returns (IUFarmPool.PerformanceCommissionStep memory) {
		return
			IUFarmPool.PerformanceCommissionStep({
				step: uint16((packedPerformanceCommissionStep >> (stepNumber * 32)) & MAX_COMMISSION_STEP),
				commission: uint16(
					(packedPerformanceCommissionStep >> (stepNumber * 32 + 16)) & MAX_COMMISSION_STEP
				)
			});
	}
}
