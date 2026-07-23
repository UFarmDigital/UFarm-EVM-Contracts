// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {UFarmCore} from "../core/UFarmCore.sol";

contract UFarmCoreV2Mock is UFarmCore {
    function version() external pure returns (string memory) {
        return "2";
    }
}
