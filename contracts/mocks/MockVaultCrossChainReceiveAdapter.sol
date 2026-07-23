// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CCIPClient} from "../interfaces/ccip/ICCIPRouter.sol";
import {SettlementAction} from "../libraries/SettlementAction.sol";

contract MockVaultCrossChainReceiveAdapter {
    error MockCCIPReceiveFailed(uint64 sourceChainSelector);

    function onCCIPReceive(CCIPClient.Any2EVMMessage calldata message) external pure returns (SettlementAction) {
        if (message.sourceChainSelector == 999) revert MockCCIPReceiveFailed(message.sourceChainSelector);
        if (message.data.length == 0) return SettlementAction.None;
        return SettlementAction(abi.decode(message.data, (uint256)));
    }
}
