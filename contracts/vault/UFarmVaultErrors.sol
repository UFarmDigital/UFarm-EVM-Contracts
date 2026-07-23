// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

interface IUFarmVaultErrors {
    error Unauthorized(address caller);
    error InvalidAddress();
    error InvalidMetadata();
    error InvalidAsset();
    error InvalidAmount();
    error InvalidSignature();
    error TransferDisabled();
    error AsyncFlowNotImplemented();
    error InvalidModule();
    error ModuleDelegateCallOnly();
    error FeeConfigLocked();
    error VaultNotActive();
    error RequestStateError(uint8 reason);
    error FlowPaused();
    error OracleFlowError(uint8 reason);
    error CrossChainFlowError(uint8 reason);
    error InvalidAdapter();
}
