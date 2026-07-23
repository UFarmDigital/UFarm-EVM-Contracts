// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICrossChainAdapter} from "../interfaces/ICrossChainAdapter.sol";
import {IUFarmCore} from "../interfaces/IUFarmCore.sol";
import {IUFarmVault} from "../interfaces/IUFarmVault.sol";
import {CCIPClient, ICCIPRouter} from "../interfaces/ccip/ICCIPRouter.sol";
import {CrossChainCodec} from "../libraries/CrossChainCodec.sol";
import {CrossChainReducer} from "../libraries/CrossChainReducer.sol";
import {CrossChainStorage} from "../libraries/CrossChainStorage.sol";
import {CrossChainTypes} from "../libraries/CrossChainTypes.sol";
import {ErrorCodes} from "../libraries/ErrorCodes.sol";
import {PauseMask} from "../libraries/PauseMask.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {SettlementAction} from "../libraries/SettlementAction.sol";
import {IUFarmVaultErrors} from "../vault/UFarmVaultErrors.sol";
import {IUFarmVaultCrossChainEvents} from "../vault/UFarmVaultEvents.sol";

contract CrossChainAdapter is ICrossChainAdapter, IUFarmVaultCrossChainEvents {
    using SafeERC20 for IERC20;

    address private immutable _self;

    error CrossChainAdapterDelegateCallOnly();
    uint8 private constant IGNORE_DECODE_FAILED = 1;
    uint8 private constant IGNORE_SELECTOR_MISMATCH = 2;
    uint8 private constant IGNORE_BAD_SENDER = 3;
    uint8 private constant IGNORE_INVALID_DESTINATION = 4;
    uint8 private constant IGNORE_INVALID_TOKENS = 5;
    uint8 private constant IGNORE_REDUCER = 6;

    modifier onlyDelegateCall() {
        if (address(this) == _self) revert CrossChainAdapterDelegateCallOnly();
        _;
    }

    constructor() {
        _self = address(this);
    }

    /**
     * @notice Starts a cross-chain transfer from this vault.
     * @dev Called by the vault through delegatecall. Accounting vaults send funds directly, while side vaults ask
     *      the accounting vault to approve non-zero transfers. A side vault may send a zero-value transfer directly
     *      to recover from stale cross-chain state.
     * @param destinationChainId Chain id of the vault that should receive the transfer.
     * @param amount Amount of the cross-chain token to send. Zero is allowed only for side-vault recovery messages.
     * @return settlementAction Action that tells the vault whether oracle settlement should be locked or unlocked.
     */
    function crossChainTransfer(uint64 destinationChainId, uint256 amount)
        external
        onlyDelegateCall
        returns (SettlementAction settlementAction)
    {
        IUFarmVault vault = IUFarmVault(address(this));
        IUFarmCore core = IUFarmCore(vault.core());

        _checkCrossChainNotPaused(core, vault.curator());

        uint64 accountingChainId = core.accountingChainId();
        if (accountingChainId == 0) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }

        uint64 localChainId = uint64(block.chainid);
        bool isAccounting = localChainId == accountingChainId;
        if (amount == 0 && isAccounting) revert IUFarmVaultErrors.InvalidAmount();
        if (destinationChainId == 0 || destinationChainId == localChainId) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_INVALID_CHAIN);
        }

        address crossChainToken = _requireCrossChainToken(core.crossChainToken());

        CrossChainTypes.CrossChainState storage session = CrossChainStorage.state();
        if (session.state != CrossChainTypes.CrossChainSessionState.Idle || session.outbox.exists) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_ACTIVE);
        }

        uint64 nonce = session.nonce + 1;
        session.nonce = nonce;
        session.sessionNonce = nonce;
        session.sourceChainId = localChainId;
        session.destinationChainId = destinationChainId;

        bool isZeroSideTransfer = amount == 0;
        CCIPClient.EVMTokenAmount[] memory tokenAmounts;
        if (isAccounting) {
            tokenAmounts = new CCIPClient.EVMTokenAmount[](1);
            tokenAmounts[0] = CCIPClient.EVMTokenAmount({token: crossChainToken, amount: amount});
        } else {
            tokenAmounts = new CCIPClient.EVMTokenAmount[](0);
        }
        CrossChainTypes.CrossChainOutbox storage outbox = session.outbox;
        outbox.exists = true;
        outbox.targetChainId = isAccounting || isZeroSideTransfer ? destinationChainId : accountingChainId;
        outbox.nextState = isAccounting
            ? CrossChainTypes.CrossChainSessionState.TransferDispatched
            : isZeroSideTransfer
                ? CrossChainTypes.CrossChainSessionState.Idle
                : CrossChainTypes.CrossChainSessionState.ApprovalRequested;
        outbox.message.version = CrossChainTypes.VERSION;
        outbox.message.messageType = (isAccounting || isZeroSideTransfer)
            ? CrossChainTypes.CrossChainMessageType.TransferSent
            : CrossChainTypes.CrossChainMessageType.TransferRequest;
        outbox.message.sourceChainId = localChainId;
        outbox.message.destinationChainId = destinationChainId;
        outbox.message.sessionNonce = nonce;
        outbox.message.amount = amount;
        session.state = outbox.nextState;

        emit CrossChainTransferStarted(localChainId, destinationChainId, amount, nonce);
        emit CrossChainOutboxQueued(outbox.targetChainId, uint8(outbox.message.messageType), nonce);

        bool dispatched = _dispatchOutbox(core, crossChainToken, tokenAmounts, nonce);
        if (isZeroSideTransfer && dispatched) {
            _clearSessionKeepNonce(session);
            return SettlementAction.Unlock;
        }
        return SettlementAction.Lock;
    }

    /**
     * @notice Handles an incoming CCIP message for the vault.
     * @dev Validates the router envelope, checks the cross-chain state machine, applies the accepted message, and
     *      queues or dispatches the next message when the flow requires one.
     * @param routerMessage Raw message delivered by the CCIP router.
     * @return settlementAction Action that tells the vault whether oracle settlement should be locked or unlocked.
     */
    function onCCIPReceive(CCIPClient.Any2EVMMessage calldata routerMessage)
        external
        onlyDelegateCall
        returns (SettlementAction settlementAction)
    {
        IUFarmVault vault = IUFarmVault(address(this));
        IUFarmCore core = IUFarmCore(vault.core());
        uint64 accountingChainId = core.accountingChainId();
        uint64 localChainId = uint64(block.chainid);
        address crossChainToken = core.crossChainToken();

        (bool ok, CrossChainTypes.CrossChainMessage memory message) = CrossChainCodec.decode(routerMessage.data);
        if (!ok) return _ignoreEmpty(IGNORE_DECODE_FAILED);

        {
            uint64 expectedSelector =
                core.ccipSelectorForChain(_expectedImmediateSourceChainId(message, accountingChainId));
            if (expectedSelector == 0 || routerMessage.sourceChainSelector != expectedSelector) {
                return _ignore(message, IGNORE_SELECTOR_MISMATCH);
            }
        }

        if (routerMessage.sender.length != 32 || uint96(bytes12(routerMessage.sender)) != 0) {
            return _ignore(message, IGNORE_BAD_SENDER);
        }
        address sender = address(bytes20(routerMessage.sender[12:32]));
        if (sender != address(this)) return _ignore(message, IGNORE_BAD_SENDER);

        if (!_isValidLocalDestination(message, localChainId, accountingChainId)) {
            return _ignore(message, IGNORE_INVALID_DESTINATION);
        }

        uint256 deliveredAmount;
        {
            bool tokensOk;
            (tokensOk, deliveredAmount) =
                _validateDeliveredTokens(crossChainToken, message, routerMessage.destTokenAmounts);
            if (!tokensOk) return _ignore(message, IGNORE_INVALID_TOKENS);
        }

        CrossChainTypes.CrossChainState storage session = CrossChainStorage.state();

        CrossChainTypes.CrossChainAction action = localChainId == accountingChainId
            ? CrossChainReducer.accountingAction(message, _snapshotState(session), accountingChainId)
            : CrossChainReducer.satelliteAction(message, _snapshotState(session), localChainId);
        if (action == CrossChainTypes.CrossChainAction.Ignore) return _ignore(message, IGNORE_REDUCER);

        if (action == CrossChainTypes.CrossChainAction.AcceptRequest) {
            session.sessionNonce = message.sessionNonce;
            session.sourceChainId = message.sourceChainId;
            session.destinationChainId = message.destinationChainId;
            session.state = CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion;

            CrossChainTypes.CrossChainOutbox storage approvalOutbox = session.outbox;
            approvalOutbox.exists = true;
            approvalOutbox.targetChainId = message.sourceChainId;
            approvalOutbox.nextState = CrossChainTypes.CrossChainSessionState.AwaitingSatelliteCompletion;
            approvalOutbox.message = CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferApproval,
                sourceChainId: message.sourceChainId,
                destinationChainId: message.destinationChainId,
                sessionNonce: message.sessionNonce,
                amount: message.amount
            });

            emit CrossChainOutboxQueued(
                approvalOutbox.targetChainId, uint8(approvalOutbox.message.messageType), message.sessionNonce
            );
            _dispatchOutbox(core, crossChainToken, new CCIPClient.EVMTokenAmount[](0), message.sessionNonce);
            return SettlementAction.Lock;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptApproval) {
            CrossChainTypes.CrossChainOutbox storage sentOutbox = session.outbox;
            sentOutbox.exists = true;
            sentOutbox.targetChainId = message.destinationChainId;
            sentOutbox.nextState = CrossChainTypes.CrossChainSessionState.Idle;
            sentOutbox.message = CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferSent,
                sourceChainId: message.sourceChainId,
                destinationChainId: message.destinationChainId,
                sessionNonce: message.sessionNonce,
                amount: message.amount
            });

            crossChainToken = _requireCrossChainToken(crossChainToken);
            CCIPClient.EVMTokenAmount[] memory transferAmounts = new CCIPClient.EVMTokenAmount[](1);
            transferAmounts[0] = CCIPClient.EVMTokenAmount({token: crossChainToken, amount: message.amount});
            emit CrossChainOutboxQueued(
                sentOutbox.targetChainId, uint8(sentOutbox.message.messageType), message.sessionNonce
            );
            bool dispatched = _dispatchOutbox(core, crossChainToken, transferAmounts, message.sessionNonce);
            if (!dispatched) return SettlementAction.Lock;

            _clearSessionKeepNonce(session);
            return SettlementAction.Unlock;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptTransfer) {
            emit CrossChainTransferCompleted(
                message.sourceChainId, message.destinationChainId, deliveredAmount, message.sessionNonce
            );

            if (localChainId == accountingChainId) {
                _clearSessionKeepNonce(session);
                return SettlementAction.Unlock;
            }

            CrossChainTypes.CrossChainOutbox storage outbox = session.outbox;
            outbox.exists = true;
            outbox.targetChainId = accountingChainId;
            outbox.nextState = CrossChainTypes.CrossChainSessionState.Idle;
            outbox.message = CrossChainTypes.CrossChainMessage({
                version: CrossChainTypes.VERSION,
                messageType: CrossChainTypes.CrossChainMessageType.TransferReceipt,
                sourceChainId: message.sourceChainId,
                destinationChainId: message.destinationChainId,
                sessionNonce: message.sessionNonce,
                amount: deliveredAmount
            });

            emit CrossChainOutboxQueued(outbox.targetChainId, uint8(outbox.message.messageType), message.sessionNonce);
            bool dispatched =
                _dispatchOutbox(core, crossChainToken, new CCIPClient.EVMTokenAmount[](0), message.sessionNonce);
            if (!dispatched) return SettlementAction.Lock;

            _clearSessionKeepNonce(session);
            return SettlementAction.Unlock;
        }

        if (action == CrossChainTypes.CrossChainAction.AcceptReceipt) {
            emit CrossChainTransferCompleted(
                message.sourceChainId, message.destinationChainId, message.amount, message.sessionNonce
            );
            _clearSessionKeepNonce(session);
            return SettlementAction.Unlock;
        }

        emit CrossChainSessionReset(message.destinationChainId, message.sessionNonce);
        _clearSessionKeepNonce(session);
        return SettlementAction.Unlock;
    }

    /**
     * @notice Tries to send the currently queued cross-chain outbox message again.
     * @dev Used when CCIP fee estimation or dispatch failed and the vault kept the message in its outbox.
     * @return settlementAction Action that tells the vault whether oracle settlement should be locked or unlocked.
     */
    function manualResendCrossChainMessage() external onlyDelegateCall returns (SettlementAction settlementAction) {
        IUFarmVault vault = IUFarmVault(address(this));
        IUFarmCore core = IUFarmCore(vault.core());
        _checkCrossChainNotPaused(core, vault.curator());

        uint64 accountingChainId = core.accountingChainId();
        if (accountingChainId == 0) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }
        CrossChainTypes.CrossChainState storage session = CrossChainStorage.state();
        CrossChainTypes.CrossChainOutbox storage outbox = session.outbox;
        if (!outbox.exists) revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NO_OUTBOX);
        CrossChainTypes.CrossChainMessageType outboxMessageType = outbox.message.messageType;
        CrossChainTypes.CrossChainSessionState outboxNextState = outbox.nextState;
        uint64 outboxSessionNonce = outbox.message.sessionNonce;

        CCIPClient.EVMTokenAmount[] memory tokenAmounts;
        address crossChainToken = core.crossChainToken();
        if (outboxMessageType == CrossChainTypes.CrossChainMessageType.TransferSent) {
            crossChainToken = _requireCrossChainToken(crossChainToken);
            tokenAmounts = new CCIPClient.EVMTokenAmount[](outbox.message.amount == 0 ? 0 : 1);
            if (tokenAmounts.length != 0) {
                tokenAmounts[0] = CCIPClient.EVMTokenAmount({token: crossChainToken, amount: outbox.message.amount});
            }
        } else {
            tokenAmounts = new CCIPClient.EVMTokenAmount[](0);
        }

        bool dispatched = _dispatchOutbox(core, crossChainToken, tokenAmounts, outboxSessionNonce);
        if (!dispatched) return SettlementAction.Lock;

        if (outboxNextState == CrossChainTypes.CrossChainSessionState.Idle) {
            _clearSessionKeepNonce(session);
            return SettlementAction.Unlock;
        }

        session.sessionNonce = outboxSessionNonce;
        session.state = outboxNextState;
        return SettlementAction.Lock;
    }

    /**
     * @notice Sends a reset message from the accounting vault to a side vault.
     * @dev Can only be started by the accounting vault while the local cross-chain session is idle and has no outbox.
     * @param targetChainId Side-chain id of the vault that should receive the reset message.
     * @return settlementAction Action that tells the vault whether oracle settlement should be locked or unlocked.
     */
    function manualResetCrossChainSession(uint64 targetChainId)
        external
        onlyDelegateCall
        returns (SettlementAction settlementAction)
    {
        IUFarmVault vault = IUFarmVault(address(this));
        IUFarmCore core = IUFarmCore(vault.core());
        _checkCrossChainNotPaused(core, vault.curator());

        uint64 accountingChainId = core.accountingChainId();
        if (accountingChainId == 0) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }

        CrossChainTypes.CrossChainState storage session = CrossChainStorage.state();
        uint64 localChainId = uint64(block.chainid);
        if (localChainId != accountingChainId) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_ACCOUNTING_CHAIN_ONLY);
        }
        if (targetChainId == 0 || targetChainId == accountingChainId) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_INVALID_CHAIN);
        }
        if (session.state != CrossChainTypes.CrossChainSessionState.Idle || session.outbox.exists) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_ACTIVE);
        }

        uint64 nonce = session.nonce + 1;
        session.nonce = nonce;
        session.sessionNonce = nonce;

        CrossChainTypes.CrossChainOutbox storage outbox = session.outbox;
        outbox.exists = true;
        outbox.targetChainId = targetChainId;
        outbox.nextState = CrossChainTypes.CrossChainSessionState.Idle;
        outbox.message = CrossChainTypes.CrossChainMessage({
            version: CrossChainTypes.VERSION,
            messageType: CrossChainTypes.CrossChainMessageType.Reset,
            sourceChainId: accountingChainId,
            destinationChainId: targetChainId,
            sessionNonce: nonce,
            amount: 0
        });

        emit CrossChainSessionReset(targetChainId, nonce);
        emit CrossChainOutboxQueued(targetChainId, uint8(CrossChainTypes.CrossChainMessageType.Reset), nonce);

        address crossChainToken = core.crossChainToken();
        bool dispatched = _dispatchOutbox(core, crossChainToken, new CCIPClient.EVMTokenAmount[](0), nonce);
        if (!dispatched) return SettlementAction.Lock;

        _clearSessionKeepNonce(session);
        return SettlementAction.Unlock;
    }

    /**
     * @notice Clears the local cross-chain session when there is no pending outbox message.
     * @dev Can be used on any configured chain by an account with the core cross-chain guard permission.
     * @return settlementAction Action that tells the vault whether oracle settlement should be locked or unlocked.
     */
    function emergencyResetCrossChainSession() external onlyDelegateCall returns (SettlementAction settlementAction) {
        IUFarmVault vault = IUFarmVault(address(this));
        IUFarmCore core = IUFarmCore(vault.core());
        _checkCrossChainNotPaused(core, vault.curator());

        uint64 accountingChainId = core.accountingChainId();
        if (accountingChainId == 0) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }
        if (!core.accountHasPermission(msg.sender, Permissions.MEMBER | Permissions.CORE_CROSSCHAIN_GUARD_MANAGER)) {
            revert IUFarmVaultErrors.Unauthorized(msg.sender);
        }

        CrossChainTypes.CrossChainState storage session = CrossChainStorage.state();
        if (session.outbox.exists) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_ACTIVE);
        }

        uint64 nonce = session.sessionNonce;
        _clearSessionKeepNonce(session);
        emit CrossChainSessionReset(uint64(block.chainid), nonce);
        return SettlementAction.Unlock;
    }

    function _checkCrossChainNotPaused(IUFarmCore core, address curator) internal view {
        uint256 globalMask = core.globalPauseMask();
        if (
            PauseMask.isPaused(globalMask, PauseMask.FULL_PROTOCOL_PAUSE)
                || PauseMask.isPaused(globalMask, PauseMask.CROSS_CHAIN_OPERATIONS_PAUSED)
                || core.curatorPauseMask(curator) != 0
        ) {
            revert IUFarmVaultErrors.FlowPaused();
        }
    }

    function _requireCrossChainToken(address token) internal pure returns (address) {
        if (token == address(0)) revert IUFarmVaultErrors.InvalidAsset();
        return token;
    }

    function _dispatchOutbox(
        IUFarmCore core,
        address asset,
        CCIPClient.EVMTokenAmount[] memory tokenAmounts,
        uint64 nonce
    ) internal returns (bool) {
        CrossChainTypes.CrossChainOutbox storage outbox = CrossChainStorage.state().outbox;

        uint64 selector = core.ccipSelectorForChain(outbox.targetChainId);
        if (selector == 0) revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_INVALID_SELECTOR);

        address routerAddress = core.crossChainRouter();
        address feeToken = core.crossChainFeeToken();
        if (routerAddress == address(0) || feeToken == address(0)) {
            revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        }

        uint256 gasLimit = core.crossChainGasLimit();
        if (gasLimit == 0) revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);

        CCIPClient.EVM2AnyMessage memory routerMessage = CCIPClient.EVM2AnyMessage({
            receiver: abi.encode(address(this)),
            data: CrossChainCodec.encode(outbox.message),
            tokenAmounts: tokenAmounts,
            feeToken: feeToken,
            extraArgs: CCIPClient.argsToBytes(CCIPClient.EVMExtraArgsV1({gasLimit: gasLimit}))
        });

        ICCIPRouter router = ICCIPRouter(routerAddress);
        uint256 fee = 0;
        try router.getFee(selector, routerMessage) returns (uint256 computedFee) {
            fee = computedFee;
        } catch {
            emit CrossChainDispatchFailed(outbox.targetChainId, uint8(outbox.message.messageType), nonce);
            return false;
        }

        _setRouterApprovals(feeToken, asset, routerAddress, outbox.message.messageType, fee, outbox.message.amount);

        try router.ccipSend(selector, routerMessage) returns (bytes32 messageId) {
            _setRouterApprovals(feeToken, asset, routerAddress, outbox.message.messageType, 0, 0);
            emit CrossChainDispatchSucceeded(outbox.targetChainId, messageId, nonce);
            delete CrossChainStorage.state().outbox;
            return true;
        } catch {
            _setRouterApprovals(feeToken, asset, routerAddress, outbox.message.messageType, 0, 0);
            emit CrossChainDispatchFailed(outbox.targetChainId, uint8(outbox.message.messageType), nonce);
            return false;
        }
    }

    function _setRouterApprovals(
        address feeToken,
        address asset,
        address router,
        CrossChainTypes.CrossChainMessageType messageType,
        uint256 feeAmount,
        uint256 assetAmount
    ) internal {
        IERC20(feeToken).forceApprove(router, feeAmount);
        if (messageType == CrossChainTypes.CrossChainMessageType.TransferSent) {
            IERC20(asset).forceApprove(router, assetAmount);
        }
    }

    function _clearSessionKeepNonce(CrossChainTypes.CrossChainState storage session) internal {
        session.sessionNonce = 0;
        session.sourceChainId = 0;
        session.destinationChainId = 0;
        session.state = CrossChainTypes.CrossChainSessionState.Idle;
        delete session.outbox;
    }

    function _snapshotState(CrossChainTypes.CrossChainState storage session)
        internal
        view
        returns (CrossChainTypes.CrossChainState memory snapshot)
    {
        snapshot.nonce = session.nonce;
        snapshot.sourceChainId = session.sourceChainId;
        snapshot.destinationChainId = session.destinationChainId;
        snapshot.state = session.state;
        snapshot.outbox.exists = session.outbox.exists;
        snapshot.outbox.targetChainId = session.outbox.targetChainId;
        snapshot.outbox.nextState = session.outbox.nextState;
        snapshot.outbox.message = session.outbox.message;
        snapshot.sessionNonce = session.sessionNonce;
    }

    function _expectedImmediateSourceChainId(CrossChainTypes.CrossChainMessage memory message, uint64 accountingChainId)
        internal
        pure
        returns (uint64)
    {
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferApproval) return accountingChainId;
        if (message.messageType == CrossChainTypes.CrossChainMessageType.TransferReceipt) {
            return message.destinationChainId;
        }
        if (message.messageType == CrossChainTypes.CrossChainMessageType.Reset) return accountingChainId;
        return message.sourceChainId;
    }

    function _isValidLocalDestination(
        CrossChainTypes.CrossChainMessage memory message,
        uint64 localChainId,
        uint64 accountingChainId
    ) internal pure returns (bool) {
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

    function _validateDeliveredTokens(
        address asset,
        CrossChainTypes.CrossChainMessage memory message,
        CCIPClient.EVMTokenAmount[] calldata destTokenAmounts
    ) internal pure returns (bool, uint256) {
        if (message.messageType != CrossChainTypes.CrossChainMessageType.TransferSent) {
            return (destTokenAmounts.length == 0, 0);
        }

        if (message.amount == 0) {
            return (destTokenAmounts.length == 0, 0);
        }

        uint256 deliveredAmount = 0;
        for (uint256 i = 0; i < destTokenAmounts.length; ++i) {
            if (destTokenAmounts[i].token != asset) return (false, 0);
            deliveredAmount += destTokenAmounts[i].amount;
        }
        if (deliveredAmount == 0) return (false, 0);
        return (true, deliveredAmount);
    }

    function _ignore(CrossChainTypes.CrossChainMessage memory message, uint8 reason)
        internal
        returns (SettlementAction)
    {
        emit CrossChainMessageIgnored(message.sourceChainId, uint8(message.messageType), reason);
        return SettlementAction.None;
    }

    function _ignoreEmpty(uint8 reason) internal returns (SettlementAction) {
        emit CrossChainMessageIgnored(0, 0, reason);
        return SettlementAction.None;
    }
}
