// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainCodecHarness} from "../../../contracts/mocks/CrossChainCodecHarness.sol";
import {CrossChainReducerHarness} from "../../../contracts/mocks/CrossChainReducerHarness.sol";
import {CrossChainTypes} from "../../../contracts/libraries/CrossChainTypes.sol";
import {InvariantVm} from "../helpers/InvariantVm.sol";

contract CrossChainReducerHandler is InvariantVm {
    CrossChainCodecHarness public immutable codec;
    CrossChainReducerHarness public immutable reducer;

    bool public unexpectedCodecResult;
    bool public unexpectedAccountingAction;
    bool public unexpectedSatelliteAction;
    uint256 public calls;

    constructor(CrossChainCodecHarness codec_, CrossChainReducerHarness reducer_) {
        codec = codec_;
        reducer = reducer_;
    }

    function probeCodecRoundTrip(
        uint8 messageTypeSeed,
        uint256 sourceSeed,
        uint256 destinationSeed,
        uint256 nonceSeed,
        uint256 amountSeed
    ) external {
        calls++;

        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: _messageType(messageTypeSeed),
            sourceChainId: _nonZero64(sourceSeed),
            destinationChainId: _nonZero64(destinationSeed),
            sessionNonce: _uint64(nonceSeed),
            amount: _validAmount(_messageType(messageTypeSeed), amountSeed)
        });

        bytes memory payload = codec.encode(message);
        (bool success, CrossChainTypes.CrossChainMessage memory decoded) = codec.decode(payload);

        if (!success || !_sameMessage(message, decoded)) {
            unexpectedCodecResult = true;
        }
    }

    function probeInvalidCodec(
        uint8 invalidCaseSeed,
        uint8 messageTypeSeed,
        uint256 sourceSeed,
        uint256 destinationSeed,
        uint256 nonceSeed,
        uint256 amountSeed
    ) external {
        calls++;

        uint8 invalidCase = uint8(vm.bound(invalidCaseSeed, 0, 5));
        CrossChainTypes.CrossChainMessageType messageType = _messageType(messageTypeSeed);
        bytes memory payload;

        if (invalidCase == 0) {
            payload = abi.encode(
                CrossChainTypes.VERSION + 1,
                uint8(messageType),
                _nonZero64(sourceSeed),
                _nonZero64(destinationSeed),
                _uint64(nonceSeed),
                amountSeed == 0 ? 1 : amountSeed
            );
        } else if (invalidCase == 1) {
            payload = abi.encode(
                CrossChainTypes.VERSION,
                uint8(CrossChainTypes.CrossChainMessageType.Reset) + 1,
                _nonZero64(sourceSeed),
                _nonZero64(destinationSeed),
                _uint64(nonceSeed),
                amountSeed == 0 ? 1 : amountSeed
            );
        } else if (invalidCase == 2) {
            payload = abi.encode(
                CrossChainTypes.VERSION, uint8(messageType), 0, _nonZero64(destinationSeed), _uint64(nonceSeed), 1
            );
        } else if (invalidCase == 3) {
            payload = abi.encode(
                CrossChainTypes.VERSION, uint8(messageType), _nonZero64(sourceSeed), 0, _uint64(nonceSeed), 1
            );
        } else if (invalidCase == 4) {
            CrossChainTypes.CrossChainMessageType nonReset = CrossChainTypes.CrossChainMessageType(
                uint8(
                    vm.bound(uint8(messageTypeSeed), 0, uint8(CrossChainTypes.CrossChainMessageType.TransferApproval))
                )
            );
            payload = abi.encode(
                CrossChainTypes.VERSION,
                uint8(nonReset),
                _nonZero64(sourceSeed),
                _nonZero64(destinationSeed),
                _uint64(nonceSeed),
                0
            );
        } else {
            payload = abi.encode(
                CrossChainTypes.VERSION,
                uint8(CrossChainTypes.CrossChainMessageType.Reset),
                _nonZero64(sourceSeed),
                _nonZero64(destinationSeed),
                _uint64(nonceSeed),
                amountSeed == 0 ? 1 : amountSeed
            );
        }

        (bool success,) = codec.decode(payload);
        if (success) {
            unexpectedCodecResult = true;
        }
    }

    function probeAccounting(
        uint8 stateSeed,
        uint8 messageTypeSeed,
        bool outboxExists,
        uint256 accountingSeed,
        uint256 sessionSourceSeed,
        uint256 sessionDestinationSeed,
        uint256 sessionNonceSeed,
        uint256 messageSourceSeed,
        uint256 messageDestinationSeed,
        uint256 messageNonceSeed
    ) external {
        calls++;

        uint64 accountingChainId = _nonZero64(accountingSeed);
        CrossChainTypes.CrossChainState memory state = _state(
            _sessionState(stateSeed),
            _uint64(sessionSourceSeed),
            _uint64(sessionDestinationSeed),
            _uint64(sessionNonceSeed),
            outboxExists
        );
        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: _messageType(messageTypeSeed),
            sourceChainId: _nonZero64(messageSourceSeed),
            destinationChainId: _nonZero64(messageDestinationSeed),
            sessionNonce: _uint64(messageNonceSeed),
            amount: 1
        });

        CrossChainTypes.CrossChainAction actual = reducer.accountingAction(message, state, accountingChainId);
        CrossChainTypes.CrossChainAction expected = _expectedAccountingAction(message, state, accountingChainId);

        if (actual != expected) {
            unexpectedAccountingAction = true;
        }
    }

    function probeSatellite(
        uint8 stateSeed,
        uint8 messageTypeSeed,
        bool outboxExists,
        uint256 localSeed,
        uint256 sessionSourceSeed,
        uint256 sessionDestinationSeed,
        uint256 sessionNonceSeed,
        uint256 messageSourceSeed,
        uint256 messageDestinationSeed,
        uint256 messageNonceSeed
    ) external {
        calls++;

        uint64 localChainId = _nonZero64(localSeed);
        CrossChainTypes.CrossChainState memory state = _state(
            _sessionState(stateSeed),
            _uint64(sessionSourceSeed),
            _uint64(sessionDestinationSeed),
            _uint64(sessionNonceSeed),
            outboxExists
        );
        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: _messageType(messageTypeSeed),
            sourceChainId: _nonZero64(messageSourceSeed),
            destinationChainId: _nonZero64(messageDestinationSeed),
            sessionNonce: _uint64(messageNonceSeed),
            amount: 1
        });

        CrossChainTypes.CrossChainAction actual = reducer.satelliteAction(message, state, localChainId);
        CrossChainTypes.CrossChainAction expected = _expectedSatelliteAction(message, state, localChainId);

        if (actual != expected) {
            unexpectedSatelliteAction = true;
        }
    }

    function _expectedAccountingAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 accountingChainId
    ) private pure returns (CrossChainTypes.CrossChainAction) {
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferRequest) {
            if (
                state.state == CrossChainTypes.CrossChainSessionState.Idle && !state.outbox.exists
                    && message.sourceChainId != accountingChainId && message.sourceChainId != message.destinationChainId
            ) {
                return CrossChainTypes.CrossChainAction.AcceptRequest;
            }
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (message.messageType == CrossChainTypes.CrossChainMessageType.Reset) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (state.outbox.exists) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        bool sessionMatches = message.sourceChainId == state.sourceChainId
            && message.destinationChainId == state.destinationChainId
            && _messageNonceMatchesAccountingSession(message, state);
        if (!sessionMatches) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (
            state.state == CrossChainTypes.CrossChainSessionState.TransferDispatched
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
        ) {
            return CrossChainTypes.CrossChainAction.AcceptReceipt;
        }

        if (state.state == CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion) {
            if (
                state.destinationChainId == accountingChainId
                    && message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
            ) {
                return CrossChainTypes.CrossChainAction.AcceptTransfer;
            }

            if (
                state.destinationChainId != accountingChainId
                    && message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
            ) {
                return CrossChainTypes.CrossChainAction.AcceptReceipt;
            }
        }

        return CrossChainTypes.CrossChainAction.Ignore;
    }

    function _expectedSatelliteAction(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state,
        uint64 localChainId
    ) private pure returns (CrossChainTypes.CrossChainAction) {
        if (state.outbox.exists && message.messageType == CrossChainTypes.CrossChainMessageType.Reset) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.Reset
                && message.destinationChainId == localChainId
        ) {
            return CrossChainTypes.CrossChainAction.ApplyReset;
        }

        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                && message.destinationChainId == localChainId && (message.amount != 0 || !state.outbox.exists)
        ) {
            return CrossChainTypes.CrossChainAction.AcceptTransfer;
        }

        if (state.outbox.exists) {
            return CrossChainTypes.CrossChainAction.Ignore;
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

    function _state(
        CrossChainTypes.CrossChainSessionState sessionState,
        uint64 sourceChainId,
        uint64 destinationChainId,
        uint64 nonce,
        bool outboxExists
    ) private pure returns (CrossChainTypes.CrossChainState memory state) {
        state.nonce = nonce;
        state.sessionNonce = nonce;
        state.sourceChainId = sourceChainId;
        state.destinationChainId = destinationChainId;
        state.state = sessionState;
        state.outbox.exists = outboxExists;
        state.outbox.targetChainId = destinationChainId;
        state.outbox.nextState = CrossChainTypes.CrossChainSessionState.Idle;
        state.outbox.message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.Reset,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId,
            sessionNonce: nonce,
            amount: 0
        });
    }

    function _messageNonceMatchesAccountingSession(
        CrossChainTypes.CrossChainMessage memory message,
        CrossChainTypes.CrossChainState memory state
    ) private pure returns (bool) {
        if (
            state.state == CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion && message.amount == 0
                && (message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                    || message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt)
        ) {
            return message.sessionNonce >= state.sessionNonce;
        }
        return message.sessionNonce == state.sessionNonce;
    }

    function _sameMessage(CrossChainTypes.CrossChainMessage memory left, CrossChainTypes.CrossChainMessage memory right)
        private
        pure
        returns (bool)
    {
        return left.version == right.version && left.messageType == right.messageType
            && left.sourceChainId == right.sourceChainId && left.destinationChainId == right.destinationChainId
            && left.sessionNonce == right.sessionNonce && left.amount == right.amount;
    }

    function _messageType(uint8 seed) private pure returns (CrossChainTypes.CrossChainMessageType) {
        return CrossChainTypes.CrossChainMessageType(seed % (uint8(CrossChainTypes.CrossChainMessageType.Reset) + 1));
    }

    function _validAmount(CrossChainTypes.CrossChainMessageType messageType, uint256 amountSeed)
        private
        pure
        returns (uint256)
    {
        if (messageType == CrossChainTypes.CrossChainMessageType.Reset) {
            return 0;
        }
        if (
            messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                || messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
        ) {
            return amountSeed;
        }
        return amountSeed == 0 ? 1 : amountSeed;
    }

    function _sessionState(uint8 seed) private pure returns (CrossChainTypes.CrossChainSessionState) {
        return CrossChainTypes.CrossChainSessionState(
            seed % (uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion) + 1)
        );
    }

    function _nonZero64(uint256 seed) private pure returns (uint64) {
        return uint64((seed % type(uint64).max) + 1);
    }

    function _uint64(uint256 seed) private pure returns (uint64) {
        return uint64(seed);
    }
}
