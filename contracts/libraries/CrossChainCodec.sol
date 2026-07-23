// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {CrossChainTypes} from "./CrossChainTypes.sol";

library CrossChainCodec {
    uint256 internal constant ENCODED_LENGTH = 6 * 32;

    function encode(CrossChainTypes.CrossChainMessage memory message) internal pure returns (bytes memory) {
        return abi.encode(
            message.version,
            uint8(message.messageType),
            message.sourceChainId,
            message.destinationChainId,
            message.sessionNonce,
            message.amount
        );
    }

    function decode(bytes memory raw)
        internal
        pure
        returns (bool ok, CrossChainTypes.CrossChainMessage memory message)
    {
        if (raw.length != ENCODED_LENGTH) {
            return (false, message);
        }

        uint256 versionWord;
        uint256 typeWord;
        uint256 sourceWord;
        uint256 destinationWord;
        uint256 nonceWord;
        uint256 amountWord;

        // slither-disable-next-line assembly
        assembly ("memory-safe") {
            let data := add(raw, 32)
            versionWord := mload(data)
            typeWord := mload(add(data, 32))
            sourceWord := mload(add(data, 64))
            destinationWord := mload(add(data, 96))
            nonceWord := mload(add(data, 128))
            amountWord := mload(add(data, 160))
        }

        if (versionWord != CrossChainTypes.VERSION) {
            return (false, message);
        }

        if (typeWord > uint8(CrossChainTypes.CrossChainMessageType.Reset)) {
            return (false, message);
        }

        if (sourceWord == 0 || sourceWord > type(uint64).max) {
            return (false, message);
        }

        if (destinationWord == 0 || destinationWord > type(uint64).max) {
            return (false, message);
        }

        if (nonceWord > type(uint64).max) {
            return (false, message);
        }

        CrossChainTypes.CrossChainMessageType messageType = CrossChainTypes.CrossChainMessageType(uint8(typeWord));
        if (messageType == CrossChainTypes.CrossChainMessageType.Reset && amountWord != 0) {
            return (false, message);
        }
        if (
            amountWord == 0 && messageType != CrossChainTypes.CrossChainMessageType.Reset
                && messageType != CrossChainTypes.CrossChainMessageType.TransferSent
                && messageType != CrossChainTypes.CrossChainMessageType.TransferReceipt
        ) return (false, message);

        message = CrossChainTypes.CrossChainMessage({
            version: uint16(versionWord),
            messageType: messageType,
            sourceChainId: uint64(sourceWord),
            destinationChainId: uint64(destinationWord),
            sessionNonce: uint64(nonceWord),
            amount: amountWord
        });

        return (true, message);
    }
}
