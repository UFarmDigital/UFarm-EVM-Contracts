// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {InvalidFee} from "./FeeMathErrors.sol";

library FeeMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant PROTOCOL_SPLIT = 0.2e18;
    uint256 internal constant MAX_PERIOD_FEE = 0.5e18;
    uint256 internal constant PERFORMANCE_FEE_BPS_CAP = 5_000;
    uint256 internal constant PERFORMANCE_FEE_STEPS = 4;
    uint256 internal constant PERFORMANCE_FEE_STEP_BITS = 32;
    uint256 internal constant PERFORMANCE_FEE_STEP_MASK = 0xffffffff;
    uint256 internal constant PERFORMANCE_FEE_FIELD_MASK = 0xffff;
    uint256 internal constant PERFORMANCE_FEE_MAX_THRESHOLD_BPS = type(uint16).max;

    function aumFeeShares(uint256 supply, uint256 annualFee, uint256 elapsed) internal pure returns (uint256) {
        if (supply == 0 || annualFee == 0 || elapsed == 0) return 0;

        uint256 periodFee = Math.mulDiv(annualFee, elapsed, YEAR);
        if (periodFee > MAX_PERIOD_FEE) periodFee = MAX_PERIOD_FEE;

        return Math.mulDiv(supply, periodFee, WAD - periodFee);
    }

    function isValidPerformanceFeeSchedule(uint256 packedSchedule) internal pure returns (bool) {
        uint256 schedule = uint256(uint128(packedSchedule));
        if (schedule == 0) return packedSchedule == 0;

        uint256 previousThreshold = 0;
        for (uint256 i = 0; i < PERFORMANCE_FEE_STEPS; ++i) {
            uint256 step = (schedule >> (i * PERFORMANCE_FEE_STEP_BITS)) & PERFORMANCE_FEE_STEP_MASK;
            if (step == 0) return false;

            uint256 feeBps = step & PERFORMANCE_FEE_FIELD_MASK;
            uint256 thresholdBps = (step >> 16) & PERFORMANCE_FEE_FIELD_MASK;
            if (feeBps > PERFORMANCE_FEE_BPS_CAP || thresholdBps <= previousThreshold) return false;
            if (thresholdBps == PERFORMANCE_FEE_MAX_THRESHOLD_BPS) {
                return schedule >> ((i + 1) * PERFORMANCE_FEE_STEP_BITS) == 0;
            }

            previousThreshold = thresholdBps;
        }

        return false;
    }

    function performanceFeeShares(uint256 nav, uint256 supply, uint256 highWaterMark, uint256 schedule)
        internal
        pure
        returns (uint256 feeShares, uint256 sharePrice)
    {
        if (supply == 0) return (0, 0);

        sharePrice = Math.mulDiv(nav, WAD, supply);
        if (schedule == 0 || sharePrice <= highWaterMark) return (0, sharePrice);

        uint256 lowerPrice = highWaterMark;
        uint256 feeValue = 0;
        for (uint256 i = 0; i < PERFORMANCE_FEE_STEPS; ++i) {
            uint256 step = (schedule >> (i * PERFORMANCE_FEE_STEP_BITS)) & PERFORMANCE_FEE_STEP_MASK;
            uint256 feeBps = step & PERFORMANCE_FEE_FIELD_MASK;
            uint256 thresholdBps = (step >> 16) & PERFORMANCE_FEE_FIELD_MASK;
            uint256 upperPrice = thresholdBps == PERFORMANCE_FEE_MAX_THRESHOLD_BPS
                ? sharePrice
                : highWaterMark + Math.mulDiv(highWaterMark, thresholdBps, BPS);
            if (upperPrice > sharePrice) upperPrice = sharePrice;

            if (upperPrice > lowerPrice && feeBps != 0) {
                uint256 sliceValue = Math.mulDiv(upperPrice - lowerPrice, supply, WAD);
                feeValue += Math.mulDiv(sliceValue, feeBps, BPS);
            }
            if (thresholdBps == PERFORMANCE_FEE_MAX_THRESHOLD_BPS || upperPrice == sharePrice) break;
            lowerPrice = upperPrice;
        }

        if (feeValue == 0) return (0, sharePrice);
        uint256 maxFeeValue = nav / 2;
        if (feeValue > maxFeeValue) feeValue = maxFeeValue;

        feeShares = Math.mulDiv(feeValue, supply, nav - feeValue);
    }

    function splitCuratorFee(uint256 shares, bool zeroUFarmFee)
        internal
        pure
        returns (uint256 protocolCut, uint256 curatorCut)
    {
        if (zeroUFarmFee) return (0, shares);
        protocolCut = Math.mulDiv(shares, PROTOCOL_SPLIT, WAD);
        curatorCut = shares - protocolCut;
    }
}
