// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainReducer} from "../libraries/CrossChainReducer.sol";
import {CrossChainTypes} from "../libraries/CrossChainTypes.sol";

contract CrossChainReducerHarness {
    function accountingAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 accountingChainId
    ) external pure returns (CrossChainTypes.CrossChainAction) {
        return CrossChainReducer.accountingAction(message, state, accountingChainId);
    }

    function satelliteAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 localChainId
    ) external pure returns (CrossChainTypes.CrossChainAction) {
        return CrossChainReducer.satelliteAction(message, state, localChainId);
    }
}
