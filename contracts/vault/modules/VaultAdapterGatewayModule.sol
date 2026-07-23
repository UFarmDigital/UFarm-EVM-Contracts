// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArbitraryAdapterEIP712} from "../../interfaces/IArbitraryAdapter.sol";
import {ICrossChainAdapter} from "../../interfaces/ICrossChainAdapter.sol";
import {CCIPClient} from "../../interfaces/ccip/ICCIPRouter.sol";
import {IUFarmCore} from "../../interfaces/IUFarmCore.sol";
import {IUFarmVaultAdapters} from "../../interfaces/IUFarmVaultAdapters.sol";
import {ErrorCodes} from "../../libraries/ErrorCodes.sol";
import {PauseMask} from "../../libraries/PauseMask.sol";
import {Permissions} from "../../libraries/Permissions.sol";
import {SettlementAction} from "../../libraries/SettlementAction.sol";
import {VaultBaseStorage} from "../../libraries/VaultBaseStorage.sol";
import {VaultGuards} from "../../libraries/VaultGuards.sol";
import {VaultPermissionStorage} from "../../libraries/VaultPermissionStorage.sol";
import {IUFarmVaultErrors} from "../UFarmVaultErrors.sol";

contract VaultAdapterGatewayModule is ReentrancyGuard, IUFarmVaultAdapters {
    bytes32 private constant ARBITRARY_ADAPTER_ID = keccak256("ufarm.adapter.arbitrary");
    bytes32 private constant CROSS_CHAIN_ADAPTER_ID = keccak256("ufarm.adapter.cross-chain");
    uint256 internal constant MEMBER = Permissions.MEMBER;
    uint256 internal constant VAULT_ASSET_MANAGER = Permissions.VAULT_ASSET_MANAGER;

    address private immutable _self;

    constructor() {
        _self = address(this);
    }

    modifier onlyDelegateCall() {
        if (address(this) == _self) revert IUFarmVaultErrors.ModuleDelegateCallOnly();
        _;
    }

    /// @notice Executes a configured vault adapter.
    /// @dev Delegatecalls the adapter and applies the returned settlement action.
    /// @param adapterId Identifier used to resolve the adapter from core.
    /// @param data Calldata passed to the adapter.
    function executeAdapter(bytes32 adapterId, bytes calldata data) external override onlyDelegateCall nonReentrant {
        // slither-disable-start reentrancy-benign
        // slither-disable-start reentrancy-no-eth
        _checkPermission(MEMBER | VAULT_ASSET_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ADAPTER_EXECUTION_PAUSED);

        bytes memory returnData = _delegateToVaultAdapter(adapterId, data);
        SettlementAction settlementAction = abi.decode(returnData, (SettlementAction));
        VaultGuards.applySettlementAction(settlementAction);
        emit AdapterExecuted(adapterId);
        // slither-disable-end reentrancy-no-eth
        // slither-disable-end reentrancy-benign
    }

    /// @notice Receives and processes a CCIP message for the vault.
    /// @dev Only the configured CCIP router may call this through the vault. Reverts from pause checks, oracle-active
    ///      state, adapter routing, or cross-chain handling propagate to the CCIP router. Operators may need to recover
    ///      failed or expired CCIP messages through Chainlink CCIP OffRamp `manuallyExecute`.
    /// @param message CCIP message delivered by the router.
    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external onlyDelegateCall nonReentrant {
        // slither-disable-start reentrancy-benign
        VaultGuards.checkNotPaused(PauseMask.CROSS_CHAIN_OPERATIONS_PAUSED);
        address router = IUFarmCore(VaultBaseStorage.data().core).crossChainRouter();
        if (router == address(0)) revert IUFarmVaultErrors.CrossChainFlowError(ErrorCodes.CROSS_CHAIN_NOT_CONFIGURED);
        if (msg.sender != router) revert IUFarmVaultErrors.Unauthorized(msg.sender);

        bytes memory returnData = _delegateToVaultAdapter(
            CROSS_CHAIN_ADAPTER_ID, abi.encodeCall(ICrossChainAdapter.onCCIPReceive, (message))
        );
        SettlementAction settlementAction = abi.decode(returnData, (SettlementAction));
        VaultGuards.applySettlementAction(settlementAction);
        // slither-disable-end reentrancy-benign
    }

    /// @notice Authorizes a structured message for ERC-1271 signature checks.
    /// @dev The arbitrary adapter guard computes the digest that is stored as signed.
    /// @param dapp Dapp identifier used by the arbitrary adapter guard.
    /// @param message Encoded message to authorize.
    function signMessage(bytes32 dapp, bytes calldata message) external onlyDelegateCall nonReentrant {
        // slither-disable-start reentrancy-benign
        _checkPermission(MEMBER | VAULT_ASSET_MANAGER);
        VaultGuards.checkNotPaused(PauseMask.ADAPTER_EXECUTION_PAUSED);

        bytes memory returnData = _delegateToVaultAdapter(
            ARBITRARY_ADAPTER_ID, abi.encodeCall(IArbitraryAdapterEIP712.eip712Hash, (dapp, message))
        );
        bytes32 digest = abi.decode(returnData, (bytes32));
        if (digest == bytes32(0)) revert IUFarmVaultErrors.Unauthorized(msg.sender);
        VaultPermissionStorage.data().signedMessages[digest] = true;
        VaultGuards.applySettlementAction(SettlementAction.Cooldown);
        // slither-disable-end reentrancy-benign
    }

    /// @notice Revokes a previously authorized digest.
    /// @param digest Digest to mark as not signed.
    function revokeSignedMessage(bytes32 digest) external onlyDelegateCall {
        _checkPermission(MEMBER | VAULT_ASSET_MANAGER);
        VaultPermissionStorage.data().signedMessages[digest] = false;
    }

    function _delegateToVaultAdapter(bytes32 adapterId, bytes memory data) internal returns (bytes memory returnData) {
        VaultGuards.requireOracleInactive();
        address adapter = IUFarmCore(VaultBaseStorage.data().core).adapterForVault(adapterId, address(this));
        if (adapter == address(0)) revert IUFarmVaultErrors.InvalidAdapter();

        // slither-disable-next-line controlled-delegatecall,low-level-calls
        (bool success, bytes memory result) = adapter.delegatecall(data);
        if (!success) {
            // slither-disable-next-line assembly
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    function _checkPermission(uint256 requiredMask) internal view {
        if (!Permissions.hasAll(VaultPermissionStorage.data().permissions[msg.sender], requiredMask)) {
            revert IUFarmVaultErrors.Unauthorized(msg.sender);
        }
    }
}
