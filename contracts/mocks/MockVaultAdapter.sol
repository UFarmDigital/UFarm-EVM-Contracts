// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IUFarmVault} from "../interfaces/IUFarmVault.sol";
import {SettlementAction} from "../libraries/SettlementAction.sol";

contract MockVaultAdapter {
    error MockAdapterFailed(uint256 code);
    error TimestampNotSetBeforeDelegatecall(uint256 observed, uint256 expected);

    event TargetCalled(address indexed target, bool success, bytes result);

    bytes32 private immutable _label;

    constructor(bytes32 label_) {
        _label = label_;
    }

    function echoUint256(uint256 value) external pure returns (SettlementAction) {
        return SettlementAction(value);
    }

    function label() external pure returns (SettlementAction) {
        return SettlementAction.None;
    }

    function observedSettlementAllowedAt() external view returns (uint256) {
        return IUFarmVault(address(this)).settlementAllowedAt();
    }

    function requireTimestampSetBeforeDelegatecall(uint256 settlementAction) external view returns (SettlementAction) {
        uint256 observed = IUFarmVault(address(this)).settlementAllowedAt();
        uint256 expected = block.timestamp + 1;
        if (observed != expected) revert TimestampNotSetBeforeDelegatecall(observed, expected);
        return SettlementAction(settlementAction);
    }

    function callTarget(address target, bytes calldata data, uint256 settlementAction)
        external
        returns (SettlementAction)
    {
        bytes memory payload = data;
        (bool success, bytes memory result) = target.call(payload);
        emit TargetCalled(target, success, result);
        return SettlementAction(settlementAction);
    }

    function callVault(address target, address vault, bytes calldata vaultData, uint256 settlementAction)
        external
        returns (SettlementAction)
    {
        (bool success, bytes memory result) =
            target.call(abi.encodeWithSignature("callVault(address,bytes)", vault, vaultData));
        emit TargetCalled(target, success, result);
        return SettlementAction(settlementAction);
    }

    function callVaultPair(
        address target,
        address vault,
        bytes calldata first,
        bytes calldata second,
        uint256 settlementAction
    ) external returns (SettlementAction) {
        (bool success, bytes memory result) = target.call(
            abi.encodeWithSignature("callVaultPair(address,bytes,bytes)", vault, first, second)
        );
        emit TargetCalled(target, success, result);
        return SettlementAction(settlementAction);
    }

    function callClaims(
        address target,
        address vault,
        address depositOwner,
        address redeemOwner,
        uint256 settlementAction
    ) external returns (SettlementAction) {
        (bool success, bytes memory result) = target.call(
            abi.encodeWithSignature("callClaims(address,address,address)", vault, depositOwner, redeemOwner)
        );
        emit TargetCalled(target, success, result);
        return SettlementAction(settlementAction);
    }

    function eip712Hash(bytes32, bytes calldata message) external returns (bytes32) {
        (address target, address vault, bytes memory vaultData) = abi.decode(message, (address, address, bytes));
        (bool success, bytes memory result) =
            target.call(abi.encodeWithSignature("callVault(address,bytes)", vault, vaultData));
        emit TargetCalled(target, success, result);
        return keccak256("MOCK_SIGNING_DIGEST");
    }

    function callDepositSettleExecute(
        address target,
        address vault,
        uint256 assets,
        address owner,
        bytes32 adapterId,
        bytes calldata adapterData,
        uint256 settlementAction
    ) external returns (SettlementAction) {
        (bool success, bytes memory result) = target.call(
            abi.encodeWithSignature(
                "callDepositSettleExecute(address,uint256,address,bytes32,bytes)",
                vault,
                assets,
                owner,
                adapterId,
                adapterData
            )
        );
        emit TargetCalled(target, success, result);
        return SettlementAction(settlementAction);
    }

    function fail(uint256 code) external pure {
        revert MockAdapterFailed(code);
    }
}
