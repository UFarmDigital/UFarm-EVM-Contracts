// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CCIPClient, ICCIPRouter} from "../interfaces/ccip/ICCIPRouter.sol";
import {IUFarmVaultCrossChain} from "../interfaces/IUFarmVaultCrossChain.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockCCIPRouter is ICCIPRouter {
    error MockCCIPRouterForcedFailure();
    error MockCCIPRouterInvalidMessage();

    event MockCCIPSent(bytes32 indexed messageId, uint64 indexed destinationSelector, address indexed sender);

    bool public failGetFee;
    bool public failSend;
    uint256 public fee;
    bytes32 public nextMessageId = bytes32(uint256(1));

    uint64 public lastDestinationSelector;
    address public lastSender;
    bytes public lastReceiver;
    bytes public lastData;
    bytes public lastExtraArgs;
    address public lastFeeToken;
    uint256 public lastTokenAmountCount;
    CCIPClient.EVMTokenAmount[] private _lastTokenAmounts;

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setFailGetFee(bool failGetFee_) external {
        failGetFee = failGetFee_;
    }

    function setFailSend(bool failSend_) external {
        failSend = failSend_;
    }

    function setNextMessageId(bytes32 nextMessageId_) external {
        nextMessageId = nextMessageId_;
    }

    function lastTokenAmount(uint256 index) external view returns (address token, uint256 amount) {
        CCIPClient.EVMTokenAmount storage tokenAmount = _lastTokenAmounts[index];
        return (tokenAmount.token, tokenAmount.amount);
    }

    function getFee(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external
        view
        returns (uint256)
    {
        if (destinationChainSelector == 0 || message.receiver.length == 0) revert MockCCIPRouterInvalidMessage();
        if (failGetFee) revert MockCCIPRouterForcedFailure();
        return fee;
    }

    function ccipSend(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external
        returns (bytes32 messageId)
    {
        if (destinationChainSelector == 0 || message.receiver.length == 0) {
            revert MockCCIPRouterInvalidMessage();
        }
        if (failSend) revert MockCCIPRouterForcedFailure();

        lastDestinationSelector = destinationChainSelector;
        lastSender = msg.sender;
        lastReceiver = message.receiver;
        lastData = message.data;
        lastExtraArgs = message.extraArgs;
        lastFeeToken = message.feeToken;
        lastTokenAmountCount = message.tokenAmounts.length;
        delete _lastTokenAmounts;

        for (uint256 i = 0; i < message.tokenAmounts.length; ++i) {
            _lastTokenAmounts.push(message.tokenAmounts[i]);
        }

        if (fee != 0) {
            IERC20(message.feeToken).transferFrom(msg.sender, address(this), fee);
        }

        messageId = nextMessageId;
        emit MockCCIPSent(messageId, destinationChainSelector, msg.sender);
        nextMessageId = bytes32(uint256(messageId) + 1);
    }

    function deliver(address vault, CCIPClient.Any2EVMMessage calldata message) external {
        IUFarmVaultCrossChain(vault).ccipReceive(message);
    }
}
