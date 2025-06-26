// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Controller} from "../Controller.sol";
import {NZGuard} from "../../../shared/NZGuard.sol";
import {IUFarmPool} from "../../pool/IUFarmPool.sol";

interface IGuard {
	/**
     * @notice Checks whether the provided dApp and method call are allowed.
     * @param dapp The identifier of the dApp.
     * @param dappAddress The address of the dApp.
     * @param payload The calldata containing the method selector.
     * @return True if the protocol and method call are allowed, false otherwise.
     */
	function isProtocolAllowed(
		bytes32 dapp,
		address dappAddress,
		bytes calldata payload
	) external view returns (bool);
}

/**
 * @title ArbitraryController
 * @notice This contract acts as an intermediary for executing whitelisted actions on external dApps.
 * @dev Calls to `performAction` must be made via `delegatecall` from a UFarmPool contract.
 */
contract ArbitraryController is Controller, NZGuard, ReentrancyGuard {
	/// @notice The contract responsible for validating allowed protocols and methods.
	IGuard public immutable guard;

	/// @notice Emitted when an action is successfully executed.
    /// @param dapp The identifier of the dApp.
    /// @param payload The calldata that was executed.
	event Executed(bytes32 indexed dapp, bytes payload);

	/// @notice Reverts if the protocol or method is not whitelisted.
	error ProtocolOrPayloadNotAllowed();
	/// @notice Reverts if an external call fails.
	error ExternalCallFailed();

	/**
     * @notice Deploys the ArbitraryController contract.
     * @dev Ensures that a valid address is provided for the `guard` contract.
     * @param _guard The address of the Guard contract.
     */
	constructor(address _guard) nonZeroAddress(_guard) {
		guard = IGuard(_guard);
	}

	/**
     * @notice Executes a whitelisted action on an external dApp.
     * @dev Must be called via `delegatecall` from a UFarmPool contract. Checks:
     * - The payload is non-empty.
     * - The action is allowed via `Guard - isProtocolAllowed()`.
     * - Executes the provided payload on the target dApp.
     * @param dapp The identifier of the dApp.
     * @param dappAddress The address of the dApp.
     * @param payload The calldata containing the method signature and parameters.
     */
	function performAction(
		bytes32 dapp,
		address dappAddress,
		bytes calldata payload,
		uint256 value
	) external payable checkDelegateCall nonReentrant nonZeroBytes32(dapp) {
		if (payload.length == 0) revert ZeroValue();
		if (!guard.isProtocolAllowed(dapp, dappAddress, payload)) revert ProtocolOrPayloadNotAllowed();
		if (!IUFarmPool(address(this)).useArbitraryController()) revert IUFarmPool.NotAllowedToUseArbController(address(this));

		(bool success, ) = dappAddress.call{value: value}(payload);
		if (!success) revert ExternalCallFailed();

		emit Executed(dapp, payload);
	}

	/**
	 * @inheritdoc Controller
	 */
	function PROTOCOL() public pure override returns (bytes32) {
		return keccak256(abi.encodePacked("ArbitraryController"));
	}
}
