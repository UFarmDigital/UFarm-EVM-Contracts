// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library CrossChainTypes {
    uint16 internal constant VERSION = 1;

    enum CrossChainMessageType {
        TransferRequest,
        TransferApproval,
        TransferSent,
        TransferReceipt,
        Reset
    }

    enum CrossChainSessionState {
        Idle,
        ApprovalRequested,
        TransferDispatched,
        AwaitingSatelliteCompletion
    }

    enum CrossChainAction {
        Ignore,
        AcceptRequest,
        AcceptApproval,
        AcceptTransfer,
        AcceptReceipt,
        ApplyReset
    }

    struct CrossChainMessage {
        uint16 version;
        CrossChainMessageType messageType;
        uint64 sourceChainId;
        uint64 destinationChainId;
        uint64 sessionNonce;
        uint256 amount;
    }

    struct CrossChainOutbox {
        bool exists;
        uint64 targetChainId;
        CrossChainSessionState nextState;
        CrossChainMessage message;
    }

    struct CrossChainState {
        uint64 nonce;
        uint64 sourceChainId;
        uint64 destinationChainId;
        CrossChainSessionState state;
        CrossChainOutbox outbox;
        uint64 sessionNonce;
    }
}
