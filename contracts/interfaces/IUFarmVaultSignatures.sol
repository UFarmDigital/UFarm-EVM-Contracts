// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmVaultSignatures {
    function signMessage(bytes32 dapp, bytes calldata message) external;
    function revokeSignedMessage(bytes32 digest) external;
    function signedMessages(bytes32 digest) external view returns (bool);
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}
