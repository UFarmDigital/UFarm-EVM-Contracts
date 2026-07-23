// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {FeeMath} from "../libraries/FeeMath.sol";

contract FeeMathHarness {
    function aumFeeShares(uint256 supply, uint256 annualFee, uint256 elapsed) external pure returns (uint256) {
        return FeeMath.aumFeeShares(supply, annualFee, elapsed);
    }

    function performanceFeeShares(uint256 nav, uint256 supply, uint256 highWaterMark, uint256 schedule)
        external
        pure
        returns (uint256 feeShares, uint256 sharePrice)
    {
        return FeeMath.performanceFeeShares(nav, supply, highWaterMark, schedule);
    }

    function isValidPerformanceFeeSchedule(uint256 packedSchedule) external pure returns (bool) {
        return FeeMath.isValidPerformanceFeeSchedule(packedSchedule);
    }

    function splitCuratorFee(uint256 shares, bool zeroUFarmFee)
        external
        pure
        returns (uint256 protocolCut, uint256 curatorCut)
    {
        return FeeMath.splitCuratorFee(shares, zeroUFarmFee);
    }
}
