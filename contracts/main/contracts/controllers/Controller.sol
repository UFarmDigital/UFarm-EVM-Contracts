// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {IController} from './IController.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';

/**
 * @title Controller base contract
 * @author https://ufarm.digital/
 */
abstract contract Controller is IController {
	address private immutable __self = address(this);

	/**
	 * @dev Error thrown when an unsupported operation is attempted.
	 */
	error UnsupportedOperation();

	/**
	 * @dev Error thrown when a function is called without delegatecall.
	 */
	error NotDelegateCalled();

	/**
	 * @dev Modifier to check if function is called via delegatecall.
	 */
	modifier checkDelegateCall() {
		if (address(this) == __self) revert NotDelegateCalled();
		_;
	}

	/**
	 * @dev Fallback function that reverts any unsupported operations.
	 */
	fallback() external virtual payable {
		revert UnsupportedOperation();
	}

	/**
	 * @dev Receive function that reverts any unsupported operations.
	 */
	receive() external virtual payable {
		revert UnsupportedOperation();
	}

	/**
	 * @dev Returns the protocol identifier.
	 * @return bytes32 The protocol identifier.
	 */
	function PROTOCOL() public view virtual returns (bytes32);

	/**
	 * @dev Returns the target of protocol action.
	 */
	function _getTarget() internal view returns (address target, bytes32 withdrawalHash) {
		return (IUFarmPool(address(this))._protocolTarget(), IUFarmPool(address(this))._withdrawalHash());
	}

	uint256[50] private __gap;
}
