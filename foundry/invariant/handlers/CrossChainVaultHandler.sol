// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ICrossChainAdapter} from "../../../contracts/interfaces/ICrossChainAdapter.sol";
import {CCIPClient} from "../../../contracts/interfaces/ccip/ICCIPRouter.sol";
import {CrossChainCodec} from "../../../contracts/libraries/CrossChainCodec.sol";
import {CrossChainTypes} from "../../../contracts/libraries/CrossChainTypes.sol";
import {MockCCIPRouter} from "../../../contracts/mocks/MockCCIPRouter.sol";
import {MockERC20} from "../../../contracts/mocks/MockERC20.sol";
import {UFarmCore} from "../../../contracts/core/UFarmCore.sol";
import {UFarmVault} from "../../../contracts/vault/UFarmVault.sol";
import {InvariantVm} from "../helpers/InvariantVm.sol";

contract CrossChainVaultHandler is InvariantVm {
    struct MessageSnapshot {
        uint16 version;
        uint8 messageType;
        uint64 sourceChainId;
        uint64 destinationChainId;
        uint64 sessionNonce;
        uint256 amount;
    }

    struct Snapshot {
        uint64 nonce;
        uint64 sessionNonce;
        uint64 sourceChainId;
        uint64 destinationChainId;
        uint8 state;
        bool outboxExists;
        uint64 outboxTargetChainId;
        uint8 outboxNextState;
        MessageSnapshot outboxMessage;
        uint256 settlementAllowedAt;
        uint256 vaultTokenBalance;
        uint256 routerTokenBalance;
        uint256 vaultFeeBalance;
        uint256 routerFeeBalance;
    }

    struct RouterConfig {
        uint256 fee;
        bool failGetFee;
        bool failSend;
    }

    struct InboundEnvelope {
        CrossChainTypes.CrossChainMessage message;
        uint64 sourceSelector;
        bool badSender;
        bool includeToken;
        uint256 tokenAmount;
        bool badToken;
    }

    UFarmCore public immutable core;
    UFarmVault public immutable vault;
    MockCCIPRouter public immutable router;
    MockERC20 public immutable crossChainToken;
    MockERC20 public immutable feeToken;

    uint64 public immutable accountingChainId;
    uint64 public immutable satelliteChainId;
    uint64 public immutable satelliteSelector;
    uint64 public immutable otherSatelliteChainId;
    uint64 public immutable otherSatelliteSelector;
    uint256 public immutable initialCrossChainTokenSupply;
    uint256 public immutable initialFeeTokenSupply;

    bytes32 public constant CROSS_CHAIN_ADAPTER_ID = keccak256("ufarm.adapter.cross-chain");
    bytes32 private constant CROSS_CHAIN_STORAGE_SLOT = keccak256("ufarm.vault.crosschain.adapter.storage");

    bool public unexpectedSessionState;
    bool public unexpectedSettlementGate;
    bool public unexpectedTokenSupply;
    bool public unexpectedRouterAllowance;
    bool public unexpectedTransitionResult;
    bool public unexpectedTransitionMutation;
    bool public unexpectedDispatchResult;
    bool public unexpectedDispatchPayload;
    bool public unexpectedNonceProgression;

    constructor(
        UFarmCore core_,
        UFarmVault vault_,
        MockCCIPRouter router_,
        MockERC20 crossChainToken_,
        MockERC20 feeToken_,
        uint64 accountingChainId_,
        uint64 satelliteChainId_,
        uint64 satelliteSelector_,
        uint64 otherSatelliteChainId_,
        uint64 otherSatelliteSelector_
    ) {
        core = core_;
        vault = vault_;
        router = router_;
        crossChainToken = crossChainToken_;
        feeToken = feeToken_;
        accountingChainId = accountingChainId_;
        satelliteChainId = satelliteChainId_;
        satelliteSelector = satelliteSelector_;
        otherSatelliteChainId = otherSatelliteChainId_;
        otherSatelliteSelector = otherSatelliteSelector_;
        initialCrossChainTokenSupply = crossChainToken_.totalSupply();
        initialFeeTokenSupply = feeToken_.totalSupply();
    }

    function startAccountingTransfer(uint256 amountSeed, uint256 feeSeed, bool failGetFee, bool failSend) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        uint256 amount = _boundedPositiveAmount(amountSeed);
        Snapshot memory beforeSnapshot = _snapshot();

        bool success =
            _executeAdapter(abi.encodeCall(ICrossChainAdapter.crossChainTransfer, (satelliteChainId, amount)));

        Snapshot memory afterSnapshot = _snapshot();
        _expectStartAccountingTransfer(beforeSnapshot, afterSnapshot, success, amount, config);
        _checkInvariants(afterSnapshot);
    }

    function startSideTransfer(
        uint256 destinationSeed,
        uint256 amountSeed,
        bool zeroAmount,
        uint256 feeSeed,
        bool failGetFee,
        bool failSend
    ) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        uint64 destinationChainId = destinationSeed % 2 == 0 ? accountingChainId : otherSatelliteChainId;
        uint256 amount = zeroAmount ? 0 : _boundedPositiveAmount(amountSeed);
        Snapshot memory beforeSnapshot = _snapshot();

        vm.chainId(satelliteChainId);
        bool success =
            _executeAdapter(abi.encodeCall(ICrossChainAdapter.crossChainTransfer, (destinationChainId, amount)));
        vm.chainId(accountingChainId);

        Snapshot memory afterSnapshot = _snapshot();
        _expectStartSideTransfer(beforeSnapshot, afterSnapshot, success, destinationChainId, amount, config);
        _checkInvariants(afterSnapshot);
    }

    function resendQueuedMessage(uint256 feeSeed, bool failGetFee, bool failSend) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        Snapshot memory beforeSnapshot = _snapshot();

        bool success = _executeAdapter(abi.encodeCall(ICrossChainAdapter.manualResendCrossChainMessage, ()));

        Snapshot memory afterSnapshot = _snapshot();
        _expectResend(beforeSnapshot, afterSnapshot, success, config);
        _checkInvariants(afterSnapshot);
    }

    function resetSatelliteSession(uint256 targetSeed, uint256 feeSeed, bool failGetFee, bool failSend) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        uint64 targetChainId = targetSeed % 2 == 0 ? satelliteChainId : otherSatelliteChainId;
        Snapshot memory beforeSnapshot = _snapshot();

        bool success = _executeAdapter(abi.encodeCall(ICrossChainAdapter.manualResetCrossChainSession, (targetChainId)));

        Snapshot memory afterSnapshot = _snapshot();
        _expectReset(beforeSnapshot, afterSnapshot, success, targetChainId, config);
        _checkInvariants(afterSnapshot);
    }

    function deliverTransferRequest(
        uint256 destinationSeed,
        uint256 nonceSeed,
        uint256 amountSeed,
        uint256 feeSeed,
        bool failGetFee,
        bool failSend,
        bool badSender
    ) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        uint64 destinationChainId = destinationSeed % 2 == 0 ? accountingChainId : otherSatelliteChainId;
        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferRequest,
                sourceChainId: satelliteChainId,
                destinationChainId: destinationChainId,
                sessionNonce: _nonZero64(nonceSeed),
                amount: _nonZeroAmount(amountSeed)
            }),
            sourceSelector: satelliteSelector,
            badSender: badSender,
            includeToken: false,
            tokenAmount: 0,
            badToken: false
        });
        _deliverAndExpect(envelope, config);
    }

    function deliverTransferApproval(uint256 nonceSeed, uint256 amountSeed, bool badSelector, bool badSender) external {
        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferApproval,
                sourceChainId: accountingChainId,
                destinationChainId: satelliteChainId,
                sessionNonce: _nonZero64(nonceSeed),
                amount: _nonZeroAmount(amountSeed)
            }),
            sourceSelector: badSelector ? satelliteSelector : core.ccipSelectorForChain(accountingChainId),
            badSender: badSender,
            includeToken: false,
            tokenAmount: 0,
            badToken: false
        });
        _deliverAndExpect(envelope, RouterConfig({fee: 0, failGetFee: false, failSend: false}));
    }

    function deliverSatelliteTransferApproval(uint256 feeSeed, bool failGetFee, bool failSend, bool badSelector)
        external
    {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        Snapshot memory beforeSnapshot = _snapshot();
        if (!_isSatelliteReachableSnapshot(beforeSnapshot)) {
            return;
        }
        uint64 destinationChainId =
            beforeSnapshot.destinationChainId == 0 ? otherSatelliteChainId : beforeSnapshot.destinationChainId;
        uint64 nonce = beforeSnapshot.nonce == 0 ? 1 : beforeSnapshot.nonce;
        uint256 amount = beforeSnapshot.outboxMessage.amount == 0 ? 1 : beforeSnapshot.outboxMessage.amount;

        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferApproval,
                sourceChainId: satelliteChainId,
                destinationChainId: destinationChainId,
                sessionNonce: nonce,
                amount: amount
            }),
            sourceSelector: badSelector ? satelliteSelector : core.ccipSelectorForChain(accountingChainId),
            badSender: false,
            includeToken: false,
            tokenAmount: 0,
            badToken: false
        });

        vm.chainId(satelliteChainId);
        bool success = _deliver(_routerMessage(envelope));
        vm.chainId(accountingChainId);

        Snapshot memory afterSnapshot = _snapshot();
        _expectSatelliteInbound(beforeSnapshot, afterSnapshot, success, envelope, config);
        _checkInvariants(afterSnapshot);
    }

    function deliverTransferSent(uint256 nonceSeed, uint256 amountSeed, bool badSelector, bool badSender, bool badToken)
        external
    {
        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
            sourceChainId: satelliteChainId,
            destinationChainId: accountingChainId,
            sessionNonce: _nonZero64(nonceSeed),
            amount: _nonZeroAmount(amountSeed)
        });

        InboundEnvelope memory envelope = InboundEnvelope({
            message: message,
            sourceSelector: badSelector ? otherSatelliteSelector : satelliteSelector,
            badSender: badSender,
            includeToken: true,
            tokenAmount: message.amount,
            badToken: badToken
        });
        _deliverAndExpect(envelope, RouterConfig({fee: 0, failGetFee: false, failSend: false}));
    }

    function deliverSatelliteTransferSent(
        uint256 nonceSeed,
        uint256 amountSeed,
        bool zeroAmount,
        uint256 feeSeed,
        bool failGetFee,
        bool failSend,
        bool badToken
    ) external {
        RouterConfig memory config = _configureRouter(feeSeed, failGetFee, failSend);
        Snapshot memory beforeSnapshot = _snapshot();
        if (!_isSatelliteReachableSnapshot(beforeSnapshot)) {
            return;
        }

        // Non-zero side-to-side TransferSent requires a prior accounting approval;
        // this direct injection target is only valid for zero-amount recovery transfers.
        if (!zeroAmount) return;
        amountSeed;
        uint256 amount = 0;
        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
                sourceChainId: otherSatelliteChainId,
                destinationChainId: satelliteChainId,
                sessionNonce: _nonZero64(nonceSeed),
                amount: amount
            }),
            sourceSelector: otherSatelliteSelector,
            badSender: false,
            includeToken: amount != 0,
            tokenAmount: amount,
            badToken: badToken
        });

        vm.chainId(satelliteChainId);
        bool success = _deliver(_routerMessage(envelope));
        vm.chainId(accountingChainId);

        Snapshot memory afterSnapshot = _snapshot();
        _expectSatelliteInbound(beforeSnapshot, afterSnapshot, success, envelope, config);
        _checkInvariants(afterSnapshot);
    }

    function deliverTransferReceipt(
        uint256 sourceSeed,
        uint256 nonceSeed,
        uint256 amountSeed,
        bool badSelector,
        bool badSender
    ) external {
        bool accountingToSatellite = sourceSeed % 2 == 0;
        uint64 sourceChainId = accountingToSatellite ? accountingChainId : satelliteChainId;
        uint64 destinationChainId = accountingToSatellite ? satelliteChainId : otherSatelliteChainId;
        uint64 selector = accountingToSatellite ? satelliteSelector : otherSatelliteSelector;

        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferReceipt,
                sourceChainId: sourceChainId,
                destinationChainId: destinationChainId,
                sessionNonce: _nonZero64(nonceSeed),
                amount: _nonZeroAmount(amountSeed)
            }),
            sourceSelector: badSelector ? satelliteSelector + otherSatelliteSelector : selector,
            badSender: badSender,
            includeToken: false,
            tokenAmount: 0,
            badToken: false
        });
        _deliverAndExpect(envelope, RouterConfig({fee: 0, failGetFee: false, failSend: false}));
    }

    function deliverReset(uint256 nonceSeed, uint256 targetSeed, bool badSelector, bool badSender) external {
        uint64 targetChainId = targetSeed % 2 == 0 ? accountingChainId : satelliteChainId;
        InboundEnvelope memory envelope = InboundEnvelope({
            message: CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.Reset,
                sourceChainId: accountingChainId,
                destinationChainId: targetChainId,
                sessionNonce: _nonZero64(nonceSeed),
                amount: 0
            }),
            sourceSelector: badSelector ? satelliteSelector : core.ccipSelectorForChain(accountingChainId),
            badSender: badSender,
            includeToken: false,
            tokenAmount: 0,
            badToken: false
        });
        _deliverAndExpect(envelope, RouterConfig({fee: 0, failGetFee: false, failSend: false}));
    }

    function deliverMalformed(uint256 selectorSeed, bytes calldata data, bool badSender) external {
        Snapshot memory beforeSnapshot = _snapshot();
        bytes memory invalidData = data;
        if (invalidData.length == 192) invalidData = abi.encodePacked(invalidData, bytes1(0));

        uint64 selector = selectorSeed % 2 == 0 ? satelliteSelector : otherSatelliteSelector;
        CCIPClient.Any2EVMMessage memory routerMessage = CCIPClient.Any2EVMMessage({
            messageId: bytes32(selectorSeed),
            sourceChainSelector: selector,
            sender: badSender ? abi.encode(address(this)) : abi.encode(address(vault)),
            data: invalidData,
            destTokenAmounts: new CCIPClient.EVMTokenAmount[](0)
        });

        bool success = _deliver(routerMessage);
        Snapshot memory afterSnapshot = _snapshot();
        if (!success || !_sameSnapshotCore(beforeSnapshot, afterSnapshot)) {
            unexpectedTransitionMutation = true;
        }
        _checkInvariants(afterSnapshot);
    }

    function deliverInvalidInboundVariant(uint8 variantSeed, uint256 nonceSeed, uint256 amountSeed) external {
        Snapshot memory beforeSnapshot = _snapshot();
        uint8 variant = variantSeed % 9;
        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
            sourceChainId: satelliteChainId,
            destinationChainId: accountingChainId,
            sessionNonce: _nonZero64(nonceSeed),
            amount: _nonZeroAmount(amountSeed)
        });

        CCIPClient.EVMTokenAmount[] memory tokenAmounts = new CCIPClient.EVMTokenAmount[](1);
        tokenAmounts[0] = CCIPClient.EVMTokenAmount({token: address(crossChainToken), amount: message.amount});
        bytes memory sender = abi.encode(address(vault));
        uint64 selector = satelliteSelector;
        bytes memory data = CrossChainCodec.encode(message);

        if (variant == 0) {
            data = abi.encodePacked(data, bytes1(0x01));
        } else if (variant == 1) {
            selector = otherSatelliteSelector;
        } else if (variant == 2) {
            sender = abi.encodePacked(bytes20(address(vault)));
        } else if (variant == 3) {
            sender = abi.encodePacked(bytes12(uint96(1)), bytes20(address(vault)));
        } else if (variant == 4) {
            sender = abi.encode(address(this));
        } else if (variant == 5) {
            message.destinationChainId = otherSatelliteChainId;
            data = CrossChainCodec.encode(message);
        } else if (variant == 6) {
            message.messageType = CrossChainTypes.CrossChainMessageType.TransferReceipt;
            data = CrossChainCodec.encode(message);
        } else if (variant == 7) {
            message.amount = 0;
            data = CrossChainCodec.encode(message);
        } else {
            tokenAmounts[0] = CCIPClient.EVMTokenAmount({token: address(feeToken), amount: message.amount});
        }

        CCIPClient.Any2EVMMessage memory routerMessage = CCIPClient.Any2EVMMessage({
            messageId: bytes32(uint256(message.sessionNonce)),
            sourceChainSelector: selector,
            sender: sender,
            data: data,
            destTokenAmounts: tokenAmounts
        });

        bool success = _deliver(routerMessage);
        Snapshot memory afterSnapshot = _snapshot();
        if (!success || !_sameSnapshotCore(beforeSnapshot, afterSnapshot)) {
            unexpectedTransitionMutation = true;
        }
        _checkInvariants(afterSnapshot);
    }

    function _deliverAndExpect(InboundEnvelope memory envelope, RouterConfig memory config) private {
        Snapshot memory beforeSnapshot = _snapshot();
        bool success = _deliver(_routerMessage(envelope));
        Snapshot memory afterSnapshot = _snapshot();

        _expectInbound(beforeSnapshot, afterSnapshot, success, envelope, config);
        _checkInvariants(afterSnapshot);
    }

    function _configureRouter(uint256 feeSeed, bool failGetFee, bool failSend)
        private
        returns (RouterConfig memory config)
    {
        config = RouterConfig({fee: vm.bound(feeSeed, 0, 100 ether), failGetFee: failGetFee, failSend: failSend});
        router.setFee(config.fee);
        router.setFailGetFee(failGetFee);
        router.setFailSend(failSend);
    }

    function _executeAdapter(bytes memory data) private returns (bool) {
        try vault.executeAdapter(CROSS_CHAIN_ADAPTER_ID, data) {
            return true;
        } catch {
            return false;
        }
    }

    function _deliver(CCIPClient.Any2EVMMessage memory routerMessage) private returns (bool) {
        try router.deliver(address(vault), routerMessage) {
            return true;
        } catch {
            return false;
        }
    }

    function _routerMessage(InboundEnvelope memory envelope)
        private
        view
        returns (CCIPClient.Any2EVMMessage memory routerMessage)
    {
        CCIPClient.EVMTokenAmount[] memory tokenAmounts = new CCIPClient.EVMTokenAmount[](envelope.includeToken ? 1 : 0);
        if (envelope.includeToken) {
            tokenAmounts[0] = CCIPClient.EVMTokenAmount({
                token: envelope.badToken ? address(feeToken) : address(crossChainToken), amount: envelope.tokenAmount
            });
        }

        routerMessage = CCIPClient.Any2EVMMessage({
            messageId: bytes32(uint256(envelope.message.sessionNonce)),
            sourceChainSelector: envelope.sourceSelector,
            sender: envelope.badSender ? abi.encode(address(this)) : abi.encode(address(vault)),
            data: CrossChainCodec.encode(envelope.message),
            destTokenAmounts: tokenAmounts
        });
    }

    function _expectStartAccountingTransfer(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        uint256 amount,
        RouterConfig memory config
    ) private {
        if (!_isFullIdle(beforeSnapshot)) {
            if (success) unexpectedTransitionResult = true;
            return;
        }
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }
        if (afterSnapshot.nonce != beforeSnapshot.nonce + 1) unexpectedNonceProgression = true;
        if (
            afterSnapshot.sessionNonce != beforeSnapshot.nonce + 1 || afterSnapshot.sourceChainId != accountingChainId
                || afterSnapshot.destinationChainId != satelliteChainId
                || afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.TransferDispatched)
                || afterSnapshot.settlementAllowedAt != type(uint256).max
        ) {
            unexpectedTransitionMutation = true;
        }

        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
            sourceChainId: accountingChainId,
            destinationChainId: satelliteChainId,
            sessionNonce: beforeSnapshot.nonce + 1,
            amount: amount
        });
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, message, config);
        _expectDispatchOutcome(beforeSnapshot, afterSnapshot, message, satelliteChainId, config, dispatchShouldSucceed);
        if (!dispatchShouldSucceed) {
            _expectOutbox(
                afterSnapshot, satelliteChainId, CrossChainTypes.CrossChainSessionState.TransferDispatched, message
            );
        }
    }

    function _expectStartSideTransfer(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        uint64 destinationChainId,
        uint256 amount,
        RouterConfig memory config
    ) private {
        if (!_isFullIdle(beforeSnapshot)) {
            if (success) unexpectedTransitionResult = true;
            return;
        }
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }
        if (afterSnapshot.nonce != beforeSnapshot.nonce + 1) unexpectedNonceProgression = true;
        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: amount == 0
                ? CrossChainTypes.CrossChainMessageType.TransferSent
                : CrossChainTypes.CrossChainMessageType.TransferRequest,
            sourceChainId: satelliteChainId,
            destinationChainId: destinationChainId,
            sessionNonce: beforeSnapshot.nonce + 1,
            amount: amount
        });
        uint64 targetChainId = amount == 0 ? destinationChainId : accountingChainId;
        CrossChainTypes.CrossChainSessionState nextState = amount == 0
            ? CrossChainTypes.CrossChainSessionState.Idle
            : CrossChainTypes.CrossChainSessionState.ApprovalRequested;
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, message, config);
        _expectDispatchOutcome(beforeSnapshot, afterSnapshot, message, targetChainId, config, dispatchShouldSucceed);

        if (dispatchShouldSucceed) {
            if (amount == 0) {
                if (
                    afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                        || afterSnapshot.sessionNonce != 0 || afterSnapshot.sourceChainId != 0
                        || afterSnapshot.destinationChainId != 0
                ) {
                    unexpectedTransitionMutation = true;
                }
                _expectCooldown(afterSnapshot);
            } else {
                if (
                    afterSnapshot.sourceChainId != satelliteChainId
                        || afterSnapshot.destinationChainId != destinationChainId
                        || afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.ApprovalRequested)
                        || afterSnapshot.sessionNonce != beforeSnapshot.nonce + 1
                        || afterSnapshot.settlementAllowedAt != type(uint256).max
                ) {
                    unexpectedTransitionMutation = true;
                }
            }
            return;
        }

        if (
            afterSnapshot.state != uint8(nextState) || afterSnapshot.settlementAllowedAt != type(uint256).max
                || afterSnapshot.sourceChainId != satelliteChainId
                || afterSnapshot.destinationChainId != destinationChainId
                || afterSnapshot.sessionNonce != beforeSnapshot.nonce + 1
        ) {
            unexpectedTransitionMutation = true;
        }
        _expectOutbox(afterSnapshot, targetChainId, nextState, message);
    }

    function _expectResend(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        RouterConfig memory config
    ) private {
        if (!beforeSnapshot.outboxExists) {
            if (success) unexpectedTransitionResult = true;
            return;
        }
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }

        CrossChainTypes.CrossChainMessage memory message = _messageFromSnapshot(beforeSnapshot.outboxMessage);
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, message, config);
        _expectDispatchOutcome(
            beforeSnapshot, afterSnapshot, message, beforeSnapshot.outboxTargetChainId, config, dispatchShouldSucceed
        );

        if (!dispatchShouldSucceed) {
            if (!_sameOutbox(beforeSnapshot, afterSnapshot) || afterSnapshot.settlementAllowedAt != type(uint256).max) {
                unexpectedTransitionMutation = true;
            }
            return;
        }

        if (beforeSnapshot.outboxNextState == uint8(CrossChainTypes.CrossChainSessionState.Idle)) {
            if (
                afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                    || afterSnapshot.sessionNonce != 0 || afterSnapshot.sourceChainId != 0
                    || afterSnapshot.destinationChainId != 0
            ) {
                unexpectedTransitionMutation = true;
            }
            _expectCooldown(afterSnapshot);
            return;
        }

        if (
            afterSnapshot.state != beforeSnapshot.outboxNextState
                || afterSnapshot.sessionNonce != beforeSnapshot.outboxMessage.sessionNonce
                || afterSnapshot.sourceChainId != beforeSnapshot.sourceChainId
                || afterSnapshot.destinationChainId != beforeSnapshot.destinationChainId
                || afterSnapshot.settlementAllowedAt != type(uint256).max
        ) {
            unexpectedTransitionMutation = true;
        }
    }

    function _expectReset(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        uint64 targetChainId,
        RouterConfig memory config
    ) private {
        if (!_isFullIdle(beforeSnapshot)) {
            if (success) unexpectedTransitionResult = true;
            return;
        }
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }
        if (afterSnapshot.nonce != beforeSnapshot.nonce + 1) unexpectedNonceProgression = true;

        CrossChainTypes.CrossChainMessage memory message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.Reset,
            sourceChainId: accountingChainId,
            destinationChainId: targetChainId,
            sessionNonce: beforeSnapshot.nonce + 1,
            amount: 0
        });
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, message, config);
        _expectDispatchOutcome(beforeSnapshot, afterSnapshot, message, targetChainId, config, dispatchShouldSucceed);

        if (dispatchShouldSucceed) {
            if (
                afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                    || afterSnapshot.sessionNonce != 0 || afterSnapshot.sourceChainId != 0
                    || afterSnapshot.destinationChainId != 0
            ) {
                unexpectedTransitionMutation = true;
            }
            _expectCooldown(afterSnapshot);
        } else {
            if (
                afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                    || afterSnapshot.sessionNonce != beforeSnapshot.nonce + 1 || afterSnapshot.sourceChainId != 0
                    || afterSnapshot.destinationChainId != 0 || afterSnapshot.settlementAllowedAt != type(uint256).max
            ) {
                unexpectedTransitionMutation = true;
            }
            _expectOutbox(afterSnapshot, targetChainId, CrossChainTypes.CrossChainSessionState.Idle, message);
        }
    }

    function _expectInbound(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        InboundEnvelope memory envelope,
        RouterConfig memory config
    ) private {
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }

        if (!_isValidInboundEnvelope(envelope)) {
            if (!_sameSnapshotCore(beforeSnapshot, afterSnapshot)) unexpectedTransitionMutation = true;
            return;
        }

        CrossChainTypes.CrossChainAction action = _expectedAccountingAction(beforeSnapshot, envelope.message);
        if (action == CrossChainTypes.CrossChainAction.Ignore) {
            if (!_sameSnapshotCore(beforeSnapshot, afterSnapshot)) unexpectedTransitionMutation = true;
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptRequest) {
            _expectAcceptRequest(beforeSnapshot, afterSnapshot, envelope.message, config);
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptTransfer) {
            _expectClearAndCooldown(beforeSnapshot, afterSnapshot);
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptReceipt) {
            _expectClearAndCooldown(beforeSnapshot, afterSnapshot);
            return;
        }

        unexpectedTransitionResult = true;
    }

    function _expectSatelliteInbound(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        bool success,
        InboundEnvelope memory envelope,
        RouterConfig memory config
    ) private {
        if (!success) {
            unexpectedTransitionResult = true;
            return;
        }

        if (!_isValidInboundEnvelopeForChain(envelope, satelliteChainId)) {
            if (!_sameSnapshotCore(beforeSnapshot, afterSnapshot)) unexpectedTransitionMutation = true;
            return;
        }

        CrossChainTypes.CrossChainAction action = _expectedSatelliteAction(beforeSnapshot, envelope.message);
        if (action == CrossChainTypes.CrossChainAction.Ignore) {
            if (!_sameSnapshotCore(beforeSnapshot, afterSnapshot)) unexpectedTransitionMutation = true;
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.ApplyReset) {
            _expectClearAndCooldown(beforeSnapshot, afterSnapshot);
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptApproval) {
            _expectAcceptApproval(beforeSnapshot, afterSnapshot, envelope.message, config);
            return;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptTransfer) {
            _expectAcceptSatelliteTransfer(beforeSnapshot, afterSnapshot, envelope.message, config);
            return;
        }

        unexpectedTransitionResult = true;
    }

    function _expectAcceptApproval(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        CrossChainTypes.CrossChainMessage memory approval,
        RouterConfig memory config
    ) private {
        CrossChainTypes.CrossChainMessage memory sent = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
            sourceChainId: approval.sourceChainId,
            destinationChainId: approval.destinationChainId,
            sessionNonce: approval.sessionNonce,
            amount: approval.amount
        });
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, sent, config);
        _expectDispatchOutcome(
            beforeSnapshot, afterSnapshot, sent, approval.destinationChainId, config, dispatchShouldSucceed
        );

        if (dispatchShouldSucceed) {
            if (
                afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                    || afterSnapshot.sessionNonce != 0 || afterSnapshot.sourceChainId != 0
                    || afterSnapshot.destinationChainId != 0
            ) {
                unexpectedTransitionMutation = true;
            }
            _expectCooldown(afterSnapshot);
            return;
        }

        if (
            afterSnapshot.state != beforeSnapshot.state || afterSnapshot.sourceChainId != beforeSnapshot.sourceChainId
                || afterSnapshot.destinationChainId != beforeSnapshot.destinationChainId
                || afterSnapshot.sessionNonce != beforeSnapshot.sessionNonce
                || afterSnapshot.settlementAllowedAt != type(uint256).max
        ) {
            unexpectedTransitionMutation = true;
        }
        _expectOutbox(afterSnapshot, approval.destinationChainId, CrossChainTypes.CrossChainSessionState.Idle, sent);
    }

    function _expectAcceptSatelliteTransfer(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        CrossChainTypes.CrossChainMessage memory sent,
        RouterConfig memory config
    ) private {
        CrossChainTypes.CrossChainMessage memory receipt = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferReceipt,
            sourceChainId: sent.sourceChainId,
            destinationChainId: sent.destinationChainId,
            sessionNonce: sent.sessionNonce,
            amount: sent.amount
        });
        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, receipt, config);
        _expectDispatchOutcome(beforeSnapshot, afterSnapshot, receipt, accountingChainId, config, dispatchShouldSucceed);

        if (dispatchShouldSucceed) {
            if (
                afterSnapshot.nonce != beforeSnapshot.nonce
                    || afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                    || afterSnapshot.sessionNonce != 0 || afterSnapshot.sourceChainId != 0
                    || afterSnapshot.destinationChainId != 0 || afterSnapshot.outboxExists
            ) {
                unexpectedTransitionMutation = true;
            }
            _expectCooldown(afterSnapshot);
            return;
        }

        if (
            afterSnapshot.state != beforeSnapshot.state || afterSnapshot.sourceChainId != beforeSnapshot.sourceChainId
                || afterSnapshot.destinationChainId != beforeSnapshot.destinationChainId
                || afterSnapshot.sessionNonce != beforeSnapshot.sessionNonce
                || afterSnapshot.settlementAllowedAt != type(uint256).max
        ) {
            unexpectedTransitionMutation = true;
        }
        _expectOutbox(afterSnapshot, accountingChainId, CrossChainTypes.CrossChainSessionState.Idle, receipt);
    }

    function _expectAcceptRequest(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        CrossChainTypes.CrossChainMessage memory message,
        RouterConfig memory config
    ) private {
        if (
            afterSnapshot.nonce != beforeSnapshot.nonce || afterSnapshot.sessionNonce != message.sessionNonce
                || afterSnapshot.sourceChainId != message.sourceChainId
                || afterSnapshot.destinationChainId != message.destinationChainId
                || afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)
                || afterSnapshot.settlementAllowedAt != type(uint256).max
        ) {
            unexpectedTransitionMutation = true;
        }

        CrossChainTypes.CrossChainMessage memory approval = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.TransferApproval,
            sourceChainId: message.sourceChainId,
            destinationChainId: message.destinationChainId,
            sessionNonce: message.sessionNonce,
            amount: message.amount
        });

        bool dispatchShouldSucceed = _dispatchShouldSucceed(beforeSnapshot, approval, config);
        _expectDispatchOutcome(
            beforeSnapshot, afterSnapshot, approval, message.sourceChainId, config, dispatchShouldSucceed
        );
        if (!dispatchShouldSucceed) {
            _expectOutbox(
                afterSnapshot,
                message.sourceChainId,
                CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion,
                approval
            );
        }
    }

    function _expectClearAndCooldown(Snapshot memory beforeSnapshot, Snapshot memory afterSnapshot) private {
        if (afterSnapshot.nonce != beforeSnapshot.nonce) unexpectedNonceProgression = true;
        if (
            afterSnapshot.sourceChainId != 0 || afterSnapshot.destinationChainId != 0
                || afterSnapshot.state != uint8(CrossChainTypes.CrossChainSessionState.Idle)
                || afterSnapshot.sessionNonce != 0 || afterSnapshot.outboxExists
        ) {
            unexpectedTransitionMutation = true;
        }
        _expectCooldown(afterSnapshot);
    }

    function _expectDispatchOutcome(
        Snapshot memory beforeSnapshot,
        Snapshot memory afterSnapshot,
        CrossChainTypes.CrossChainMessage memory message,
        uint64 targetChainId,
        RouterConfig memory config,
        bool dispatchShouldSucceed
    ) private {
        if (dispatchShouldSucceed) {
            if (afterSnapshot.outboxExists) unexpectedDispatchResult = true;
            _expectFeeMoved(beforeSnapshot, afterSnapshot, config.fee);
            _expectRouterPayload(message, targetChainId);
            return;
        }

        if (!afterSnapshot.outboxExists) unexpectedDispatchResult = true;
        _expectFeeUnchanged(beforeSnapshot, afterSnapshot);
    }

    function _expectOutbox(
        Snapshot memory snapshot,
        uint64 targetChainId,
        CrossChainTypes.CrossChainSessionState nextState,
        CrossChainTypes.CrossChainMessage memory message
    ) private {
        if (
            !snapshot.outboxExists || snapshot.outboxTargetChainId != targetChainId
                || snapshot.outboxNextState != uint8(nextState) || !_sameMessage(snapshot.outboxMessage, message)
        ) {
            unexpectedDispatchResult = true;
        }
    }

    function _expectRouterPayload(CrossChainTypes.CrossChainMessage memory message, uint64 targetChainId) private {
        (bool ok, CrossChainTypes.CrossChainMessage memory decoded) = CrossChainCodec.decode(router.lastData());
        if (!ok || !_sameMessage(decoded, message)) {
            unexpectedDispatchPayload = true;
        }
        if (
            router.lastSender() != address(vault)
                || router.lastDestinationSelector() != core.ccipSelectorForChain(targetChainId)
                || keccak256(router.lastReceiver()) != keccak256(abi.encode(address(vault)))
                || router.lastFeeToken() != address(feeToken)
                || keccak256(router.lastExtraArgs())
                    != keccak256(
                        CCIPClient.argsToBytes(CCIPClient.EVMExtraArgsV1({gasLimit: core.crossChainGasLimit()}))
                    )
        ) {
            unexpectedDispatchPayload = true;
        }

        uint256 expectedTokenAmountCount = message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
            ? (message.amount == 0 ? router.lastTokenAmountCount() : 1)
            : 0;
        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent && message.amount == 0
                && expectedTokenAmountCount > 1
        ) {
            unexpectedDispatchPayload = true;
            return;
        }
        if (router.lastTokenAmountCount() != expectedTokenAmountCount) {
            unexpectedDispatchPayload = true;
            return;
        }
        if (expectedTokenAmountCount == 1) {
            (address token, uint256 amount) = router.lastTokenAmount(0);
            if (token != address(crossChainToken) || amount != message.amount) {
                unexpectedDispatchPayload = true;
            }
        }
    }

    function _checkInvariants(Snapshot memory snapshot) private {
        if (snapshot.state > uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)) {
            unexpectedSessionState = true;
        }
        if (snapshot.outboxNextState > uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)) {
            unexpectedSessionState = true;
        }

        if (snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.Idle)) {
            if (!snapshot.outboxExists && (snapshot.sourceChainId != 0 || snapshot.destinationChainId != 0)) {
                unexpectedSessionState = true;
            }
            if (!snapshot.outboxExists && snapshot.sessionNonce != 0) unexpectedSessionState = true;
            if (!snapshot.outboxExists && snapshot.settlementAllowedAt == type(uint256).max) {
                unexpectedSettlementGate = true;
            }
        } else {
            if (snapshot.sourceChainId == 0 || snapshot.destinationChainId == 0) unexpectedSessionState = true;
            if (snapshot.sourceChainId == snapshot.destinationChainId) unexpectedSessionState = true;
            if (snapshot.sessionNonce == 0) unexpectedSessionState = true;
            if (snapshot.settlementAllowedAt != type(uint256).max) unexpectedSettlementGate = true;
        }

        if (snapshot.outboxExists) {
            if (snapshot.settlementAllowedAt != type(uint256).max) unexpectedSettlementGate = true;
            _checkOutboxShape(snapshot);
        } else if (!_emptyOutbox(snapshot)) {
            unexpectedSessionState = true;
        }

        uint256 cooldownGate = block.timestamp + core.navRequestCooldown();
        if (
            snapshot.settlementAllowedAt != 0 && snapshot.settlementAllowedAt != type(uint256).max
                && snapshot.settlementAllowedAt != cooldownGate
        ) {
            unexpectedSettlementGate = true;
        }

        if (
            snapshot.vaultTokenBalance + snapshot.routerTokenBalance != initialCrossChainTokenSupply
                || snapshot.vaultFeeBalance + snapshot.routerFeeBalance != initialFeeTokenSupply
        ) {
            unexpectedTokenSupply = true;
        }

        if (
            crossChainToken.allowance(address(vault), address(router)) != 0
                || feeToken.allowance(address(vault), address(router)) != 0
        ) {
            unexpectedRouterAllowance = true;
        }
    }

    function _checkOutboxShape(Snapshot memory snapshot) private {
        MessageSnapshot memory message = snapshot.outboxMessage;
        if (
            snapshot.outboxTargetChainId == 0 || core.ccipSelectorForChain(snapshot.outboxTargetChainId) == 0
                || message.version != CrossChainTypes.VERSION
                || message.messageType > uint8(CrossChainTypes.CrossChainMessageType.Reset)
                || message.sourceChainId == 0 || message.destinationChainId == 0
                || message.sourceChainId == message.destinationChainId
        ) {
            unexpectedSessionState = true;
        }

        if (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.Reset)) {
            if (message.amount != 0 || snapshot.outboxTargetChainId != message.destinationChainId) {
                unexpectedSessionState = true;
            }
            return;
        }

        bool zeroAmountAllowed =
            (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferSent)
                    || message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferReceipt))
                && message.sourceChainId != accountingChainId;
        if (message.amount == 0 && !zeroAmountAllowed) unexpectedSessionState = true;

        if (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferSent)) {
            if (snapshot.outboxTargetChainId != message.destinationChainId || address(crossChainToken) == address(0)) {
                unexpectedSessionState = true;
            }
        } else if (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferApproval)) {
            if (snapshot.outboxTargetChainId != message.sourceChainId) unexpectedSessionState = true;
        } else if (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferReceipt)) {
            if (snapshot.outboxTargetChainId != accountingChainId) unexpectedSessionState = true;
        } else if (message.messageType == uint8(CrossChainTypes.CrossChainMessageType.TransferRequest)) {
            if (snapshot.outboxTargetChainId != accountingChainId) unexpectedSessionState = true;
        }
    }

    function _expectedAccountingAction(Snapshot memory snapshot, CrossChainTypes.CrossChainMessage memory message)
        private
        view
        returns (CrossChainTypes.CrossChainAction)
    {
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferRequest) {
            if (
                _isFullIdle(snapshot) && message.sourceChainId != accountingChainId
                    && message.sourceChainId != message.destinationChainId
            ) {
                return CrossChainTypes.CrossChainAction.AcceptRequest;
            }
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (message.messageType == CrossChainTypes.CrossChainMessageType.Reset) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        if (snapshot.outboxExists) {
            return CrossChainTypes.CrossChainAction.Ignore;
        }

        bool sessionMatches = message.sourceChainId == snapshot.sourceChainId
            && message.destinationChainId == snapshot.destinationChainId
            && _messageNonceMatchesAccountingSession(message, snapshot);
        if (!sessionMatches) return CrossChainTypes.CrossChainAction.Ignore;

        if (
            snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.TransferDispatched)
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
        ) {
            return CrossChainTypes.CrossChainAction.AcceptReceipt;
        }

        if (snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)) {
            if (
                snapshot.destinationChainId == accountingChainId
                    && message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
            ) {
                return CrossChainTypes.CrossChainAction.AcceptTransfer;
            }
            if (
                snapshot.destinationChainId != accountingChainId
                    && message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt
            ) {
                return CrossChainTypes.CrossChainAction.AcceptReceipt;
            }
        }

        return CrossChainTypes.CrossChainAction.Ignore;
    }

    function _messageNonceMatchesAccountingSession(
        CrossChainTypes.CrossChainMessage memory message,
        Snapshot memory snapshot
    ) private pure returns (bool) {
        if (
            snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)
                && message.amount == 0
                && (message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                    || message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt)
        ) {
            return message.sessionNonce >= snapshot.sessionNonce;
        }
        return message.sessionNonce == snapshot.sessionNonce;
    }

    function _isValidInboundEnvelope(InboundEnvelope memory envelope) private view returns (bool) {
        return _isValidInboundEnvelopeForChain(envelope, accountingChainId);
    }

    function _isValidInboundEnvelopeForChain(InboundEnvelope memory envelope, uint64 localChainId)
        private
        view
        returns (bool)
    {
        CrossChainTypes.CrossChainMessage memory message = envelope.message;
        if (envelope.sourceSelector != core.ccipSelectorForChain(_expectedImmediateSourceChainId(message))) {
            return false;
        }
        if (envelope.badSender) return false;
        if (!_isValidLocalDestination(message, localChainId)) return false;
        return _validDeliveredTokens(envelope);
    }

    function _expectedImmediateSourceChainId(CrossChainTypes.CrossChainMessage memory message)
        private
        view
        returns (uint64)
    {
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferApproval) {
            return accountingChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt) {
            return message.destinationChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.Reset) return accountingChainId;
        return message.sourceChainId;
    }

    function _isValidLocalDestination(CrossChainTypes.CrossChainMessage memory message, uint64 localChainId)
        private
        view
        returns (bool)
    {
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferRequest) {
            return localChainId == accountingChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferApproval) {
            return localChainId == message.sourceChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent) {
            return localChainId == message.destinationChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt) {
            return localChainId == accountingChainId;
        }
        return localChainId == message.destinationChainId && message.sourceChainId == accountingChainId;
    }

    function _validDeliveredTokens(InboundEnvelope memory envelope) private pure returns (bool) {
        if (envelope.message.messageType != CrossChainTypes.CrossChainMessageType.TransferSent) {
            return !envelope.includeToken;
        }
        if (envelope.message.amount == 0) return !envelope.includeToken;
        return envelope.includeToken && !envelope.badToken && envelope.tokenAmount != 0;
    }

    function _expectedSatelliteAction(Snapshot memory snapshot, CrossChainTypes.CrossChainMessage memory message)
        private
        view
        returns (CrossChainTypes.CrossChainAction)
    {
        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.TransferSent
                && message.destinationChainId == satelliteChainId && (message.amount != 0 || !snapshot.outboxExists)
        ) {
            return CrossChainTypes.CrossChainAction.AcceptTransfer;
        }

        if (snapshot.outboxExists) return CrossChainTypes.CrossChainAction.Ignore;

        if (
            message.messageType == CrossChainTypes.CrossChainMessageType.Reset
                && message.destinationChainId == satelliteChainId
        ) {
            return CrossChainTypes.CrossChainAction.ApplyReset;
        }

        if (
            snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.ApprovalRequested)
                && message.messageType == CrossChainTypes.CrossChainMessageType.TransferApproval
                && message.sourceChainId == snapshot.sourceChainId
                && message.destinationChainId == snapshot.destinationChainId
                && message.sessionNonce == snapshot.sessionNonce
        ) {
            return CrossChainTypes.CrossChainAction.AcceptApproval;
        }

        return CrossChainTypes.CrossChainAction.Ignore;
    }

    function _dispatchShouldSucceed(
        Snapshot memory beforeSnapshot,
        CrossChainTypes.CrossChainMessage memory,
        RouterConfig memory config
    ) private pure returns (bool) {
        return !config.failGetFee && !config.failSend && config.fee <= beforeSnapshot.vaultFeeBalance;
    }

    function _snapshot() private view returns (Snapshot memory snapshot) {
        uint256 stateWord = uint256(vm.load(address(vault), _slot(0)));
        uint256 outboxWord = uint256(vm.load(address(vault), _slot(1)));
        uint256 messageWord = uint256(vm.load(address(vault), _slot(2)));

        snapshot.nonce = uint64(stateWord);
        snapshot.sessionNonce = uint64(uint256(vm.load(address(vault), _slot(4))));
        snapshot.sourceChainId = uint64(stateWord >> 64);
        snapshot.destinationChainId = uint64(stateWord >> 128);
        snapshot.state = uint8(stateWord >> 192);

        snapshot.outboxExists = uint8(outboxWord) != 0;
        snapshot.outboxTargetChainId = uint64(outboxWord >> 8);
        snapshot.outboxNextState = uint8(outboxWord >> 72);
        snapshot.outboxMessage = MessageSnapshot({
            version: uint16(messageWord),
            messageType: uint8(messageWord >> 16),
            sourceChainId: uint64(messageWord >> 24),
            destinationChainId: uint64(messageWord >> 88),
            sessionNonce: uint64(messageWord >> 152),
            amount: uint256(vm.load(address(vault), _slot(3)))
        });
        snapshot.settlementAllowedAt = vault.settlementAllowedAt();
        snapshot.vaultTokenBalance = crossChainToken.balanceOf(address(vault));
        snapshot.routerTokenBalance = crossChainToken.balanceOf(address(router));
        snapshot.vaultFeeBalance = feeToken.balanceOf(address(vault));
        snapshot.routerFeeBalance = feeToken.balanceOf(address(router));
    }

    function _slot(uint256 offset) private pure returns (bytes32) {
        return bytes32(uint256(CROSS_CHAIN_STORAGE_SLOT) + offset);
    }

    function _messageFromSnapshot(MessageSnapshot memory message)
        private
        pure
        returns (CrossChainTypes.CrossChainMessage memory)
    {
        return CrossChainTypes.CrossChainMessage({
            version: message.version,
            messageType: CrossChainTypes.CrossChainMessageType(message.messageType),
            sourceChainId: message.sourceChainId,
            destinationChainId: message.destinationChainId,
            sessionNonce: message.sessionNonce,
            amount: message.amount
        });
    }

    function _sameSnapshotCore(Snapshot memory left, Snapshot memory right) private pure returns (bool) {
        return left.nonce == right.nonce && left.sourceChainId == right.sourceChainId
            && left.destinationChainId == right.destinationChainId && left.state == right.state
            && left.sessionNonce == right.sessionNonce && left.outboxExists == right.outboxExists
            && left.outboxTargetChainId == right.outboxTargetChainId && left.outboxNextState == right.outboxNextState
            && _sameMessage(left.outboxMessage, right.outboxMessage)
            && left.settlementAllowedAt == right.settlementAllowedAt
            && left.vaultTokenBalance == right.vaultTokenBalance && left.routerTokenBalance == right.routerTokenBalance
            && left.vaultFeeBalance == right.vaultFeeBalance && left.routerFeeBalance == right.routerFeeBalance;
    }

    function _sameOutbox(Snapshot memory left, Snapshot memory right) private pure returns (bool) {
        return left.outboxExists == right.outboxExists && left.outboxTargetChainId == right.outboxTargetChainId
            && left.outboxNextState == right.outboxNextState && _sameMessage(left.outboxMessage, right.outboxMessage);
    }

    function _sameMessage(MessageSnapshot memory left, MessageSnapshot memory right) private pure returns (bool) {
        return left.version == right.version && left.messageType == right.messageType
            && left.sourceChainId == right.sourceChainId && left.destinationChainId == right.destinationChainId
            && left.sessionNonce == right.sessionNonce && left.amount == right.amount;
    }

    function _sameMessage(MessageSnapshot memory left, CrossChainTypes.CrossChainMessage memory right)
        private
        pure
        returns (bool)
    {
        return left.version == right.version && left.messageType == uint8(right.messageType)
            && left.sourceChainId == right.sourceChainId && left.destinationChainId == right.destinationChainId
            && left.sessionNonce == right.sessionNonce && left.amount == right.amount;
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

    function _emptyOutbox(Snapshot memory snapshot) private pure returns (bool) {
        return snapshot.outboxTargetChainId == 0 && snapshot.outboxNextState == 0 && snapshot.outboxMessage.version == 0
            && snapshot.outboxMessage.messageType == 0 && snapshot.outboxMessage.sourceChainId == 0
            && snapshot.outboxMessage.destinationChainId == 0 && snapshot.outboxMessage.sessionNonce == 0
            && snapshot.outboxMessage.amount == 0;
    }

    function _isFullIdle(Snapshot memory snapshot) private pure returns (bool) {
        return snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.Idle) && !snapshot.outboxExists;
    }

    function _isSatelliteReachableSnapshot(Snapshot memory snapshot) private view returns (bool) {
        if (uint64(block.chainid) != accountingChainId) return false;
        if (
            snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.TransferDispatched)
                || snapshot.state == uint8(CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion)
        ) {
            return false;
        }
        return snapshot.sourceChainId == 0 || snapshot.sourceChainId == satelliteChainId;
    }

    function _expectCooldown(Snapshot memory snapshot) private {
        if (snapshot.settlementAllowedAt != block.timestamp + core.navRequestCooldown()) {
            unexpectedSettlementGate = true;
        }
    }

    function _expectFeeMoved(Snapshot memory beforeSnapshot, Snapshot memory afterSnapshot, uint256 fee) private {
        if (
            afterSnapshot.vaultFeeBalance + fee != beforeSnapshot.vaultFeeBalance
                || afterSnapshot.routerFeeBalance != beforeSnapshot.routerFeeBalance + fee
        ) {
            unexpectedTransitionMutation = true;
        }
    }

    function _expectFeeUnchanged(Snapshot memory beforeSnapshot, Snapshot memory afterSnapshot) private {
        if (
            afterSnapshot.vaultFeeBalance != beforeSnapshot.vaultFeeBalance
                || afterSnapshot.routerFeeBalance != beforeSnapshot.routerFeeBalance
        ) {
            unexpectedTransitionMutation = true;
        }
    }

    function _boundedPositiveAmount(uint256 seed) private view returns (uint256) {
        uint256 balance = crossChainToken.balanceOf(address(vault));
        if (balance == 0) return 1;
        return vm.bound(seed, 1, balance);
    }

    function _nonZeroAmount(uint256 seed) private pure returns (uint256) {
        return seed == 0 ? 1 : seed;
    }

    function _nonZero64(uint256 seed) private pure returns (uint64) {
        return uint64((seed % type(uint64).max) + 1);
    }
}
