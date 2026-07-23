// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainTypes} from "./CrossChainTypes.sol";

library CrossChainReducer {
    function accountingAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 accountingChainId
    ) internal pure returns (CrossChainTypes.CrossChainAction) {
        if (state.outbox.exists) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (
            state.state == CrossChainTypes.CrossChainSessionState.Idle
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferRequest
                && message.sourceChainId != accountingChainId && message.sourceChainId != message.destinationChainId
        ) {
            return CrossChainTypes.CrossChainAction.AcceptRequest;
        }

        if (message.sourceChainId != state.sourceChainId || message.destinationChainId != state.destinationChainId) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (
            state.state == CrossChainTypes.CrossChainSessionState.TransferDispatched
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
                && message.sessionNonce == state.sessionNonce
        ) {
            return CrossChainTypes.CrossChainAction.AcceptReceipt;
        }

        if (state.state == CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion) {
            if (
                message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                    && state.destinationChainId == accountingChainId && _nonceMatches(message, state)
            ) {
                return CrossChainTypes.CrossChainAction.AcceptTransfer;
            }

            if (
                message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
                    && state.destinationChainId != accountingChainId && _nonceMatches(message, state)
            ) {
                return CrossChainTypes.CrossChainAction.AcceptReceipt;
            }
        }

        return CrossChainTypes.CrossChainAction.Ignore;
    }

    function satelliteAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 localChainId
    ) internal pure returns (CrossChainTypes.CrossChainAction) {
        // TransferSent is intentionally accepted without session-key matching.
        // The destination satellite may have no related local session (or a different active session);
        // adapter-side origin/router/selector/payload validation is the trust boundary.
        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                && message.destinationChainId == localChainId && (message.amount != 0 || !state.outbox.exists)
        ) {
            return CrossChainTypes.CrossChainAction.AcceptTransfer;
        }

        if (state.outbox.exists) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        // Reset classification is reducer-only; adapter must authenticate accounting-chain origin.
        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.Reset
                && message.destinationChainId == localChainId
        ) {
            return CrossChainTypes.CrossChainAction.ApplyReset;
        }

        if (
            state.state == CrossChainTypes.CrossChainSessionState.ApprovalRequested
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferApproval
                && message.sourceChainId == state.sourceChainId
                && message.destinationChainId == state.destinationChainId && message.sessionNonce == state.sessionNonce
        ) {
            return CrossChainTypes.CrossChainAction.AcceptApproval;
        }

        return CrossChainTypes.CrossChainAction.Ignore;
    }

    function _nonceMatches(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state
    ) private pure returns (bool) {
        if (message.amount == 0) {
            return message.sessionNonce >= state.sessionNonce;
        }
        return message.sessionNonce == state.sessionNonce;
    }
}
