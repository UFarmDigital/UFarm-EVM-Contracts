// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CCIPClient} from "./ccip/ICCIPRouter.sol";
import {SettlementAction} from "../libraries/SettlementAction.sol";

interface ICrossChainAdapter {
    function crossChainTransfer(uint64 destinationChainId, uint256 amount)
        external
        returns (SettlementAction settlementAction);

    function onCCIPReceive(CCIPClient.Any2EVMMessage calldata message)
        external
        returns (SettlementAction settlementAction);

    function manualResendCrossChainMessage() external returns (SettlementAction settlementAction);

    function manualResetCrossChainSession(uint64 targetChainId) external returns (SettlementAction settlementAction);

    function emergencyResetCrossChainSession() external returns (SettlementAction settlementAction);
}
