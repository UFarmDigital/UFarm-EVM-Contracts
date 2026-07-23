// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainCodecHarness} from "../../contracts/mocks/CrossChainCodecHarness.sol";
import {CrossChainReducerHarness} from "../../contracts/mocks/CrossChainReducerHarness.sol";
import {InvariantVm} from "./helpers/InvariantVm.sol";
import {CrossChainReducerHandler} from "./handlers/CrossChainReducerHandler.sol";

contract CrossChainReducerInvariant is InvariantVm {
    CrossChainReducerHandler internal handler;

    function setUp() external {
        handler = new CrossChainReducerHandler(new CrossChainCodecHarness(), new CrossChainReducerHarness());
        targetContract(address(handler));
    }

    function invariant_crossChainCodecAndReducerStayInModel() external view {
        _assertTrue(!handler.unexpectedCodecResult(), "codec model drift");
        _assertTrue(!handler.unexpectedAccountingAction(), "accounting reducer model drift");
        _assertTrue(!handler.unexpectedSatelliteAction(), "satellite reducer model drift");
    }
}
