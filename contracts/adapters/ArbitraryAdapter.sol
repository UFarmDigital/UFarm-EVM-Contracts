// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IArbitraryAdapter, IArbitraryAdapterEIP712, IArbitraryAdapterGuard} from "../interfaces/IArbitraryAdapter.sol";
import {SettlementAction} from "../libraries/SettlementAction.sol";

contract ArbitraryAdapter is IArbitraryAdapter, IArbitraryAdapterEIP712 {
    IArbitraryAdapterGuard public immutable guard;
    address private immutable _self;

    constructor(address guard_) {
        if (guard_ == address(0) || guard_.code.length == 0) revert ArbitraryAdapterInvalidInput();
        guard = IArbitraryAdapterGuard(guard_);
        _self = address(this);
    }

    modifier onlyDelegateCall() {
        if (address(this) == _self) revert ArbitraryAdapterDelegateCallOnly();
        _;
    }

    /**
     * @notice Executes an allowed call to an external protocol.
     * @dev Called by the vault through delegatecall. The guard validates the dapp, target, and calldata before execution,
     *      but this adapter does not validate return data, token balances, prices, or slippage after the call. Asset
     *      managers must encode protocol-level protections such as minimum output amounts in the payload.
     * @param dapp Protocol identifier used by the guard whitelist.
     * @param dappAddress Address of the external contract to call.
     * @param payload Calldata to send to the external contract.
     * @param value Native token amount to forward with the call.
     * @return settlementAction Action that tells the vault to enter oracle cooldown after the call.
     */
    function performAction(bytes32 dapp, address dappAddress, bytes calldata payload, uint256 value)
        external
        payable
        onlyDelegateCall
        returns (SettlementAction settlementAction)
    {
        if (dapp == bytes32(0) || dappAddress == address(0) || payload.length == 0) {
            revert ArbitraryAdapterInvalidInput();
        }
        if (!guard.isProtocolAllowed(dapp, dappAddress, payload)) revert ArbitraryAdapterCallNotAllowed();

        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool success, bytes memory returnData) = dappAddress.call{value: value}(payload);
        if (!success) {
            if (returnData.length == 0) revert ArbitraryAdapterExternalCallFailed();
            // slither-disable-next-line assembly
            assembly ("memory-safe") {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }

        emit ArbitraryActionExecuted(dapp, dappAddress);
        return SettlementAction.Cooldown;
    }

    /**
     * @notice Builds an allowed EIP-712 digest for a protocol message.
     * @param dapp Protocol identifier used by the guard EIP-712 whitelist.
     * @param message Encoded EIP-712 operation stream checked by the guard.
     * @return retHash Digest that the vault may sign, or zero when the message is not allowed.
     */
    function eip712Hash(bytes32 dapp, bytes calldata message) external view returns (bytes32 retHash) {
        if (dapp == bytes32(0)) revert ArbitraryAdapterInvalidInput();
        retHash = guard.eip712Hash(dapp, message);
    }
}
