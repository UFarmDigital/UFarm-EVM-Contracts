// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

library CCIPClient {
    bytes4 internal constant EVM_EXTRA_ARGS_V1_TAG = 0x97a657c9;

    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVMExtraArgsV1 {
        uint256 gasLimit;
    }

    function argsToBytes(EVMExtraArgsV1 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EVM_EXTRA_ARGS_V1_TAG, extraArgs);
    }
}

interface ICCIPRouter {
    function getFee(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external
        view
        returns (uint256 fee);

    function ccipSend(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external
        returns (bytes32 messageId);
}
