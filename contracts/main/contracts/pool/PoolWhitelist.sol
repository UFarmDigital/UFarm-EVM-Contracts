// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {ICoreWhitelist} from '../core/CoreWhitelist.sol';

interface IPoolWhitelist {
	error TokenIsNotAllowed(address token);

	function isTokenAllowed(address token) external view returns (bool);

	function isProtocolAllowed(bytes32 protocol) external view returns (bool);
}

/**
 * @title PoolWhitelist contract
 * @author https://ufarm.digital/
 * @notice Contract that implements whitelist for tokens and protocols
 */
abstract contract PoolWhitelist is IPoolWhitelist {
	function ufarmCore() public view virtual returns (address);

	error ProtocolNotAllowed(bytes32 protocol);

	/**
	 * @notice Reverts if protocol is not whitelisted here or in parent whitelist
	 * @param _protocol - protocol to check
	 */
	modifier protocolAllowed(bytes32 _protocol) {
		_checkProtocolAllowance(_protocol);
		_;
	}

	/**
	 * @notice Checks if protocol is allowed to be used in the pool
	 * @param protocol - protocol to check
	 * @return true if protocol is allowed, false otherwise
	 */
	function isProtocolAllowed(bytes32 protocol) external view override returns (bool) {
		return _isProtocolAllowed(protocol);
	}

	/**
	 * @notice Checks if protocol is allowed to be used in the pool, revert if not
	 * @param _protocol - protocol to check
	 */
	function _checkProtocolAllowance(bytes32 _protocol) internal view {
		if (!_isProtocolAllowed(_protocol)) revert ProtocolNotAllowed(_protocol);
	}

	/**
	 * @notice Checks if protocol is allowed on the platform
	 * @param _protocol - protocol to check
	 * @return true if protocol is allowed, false otherwise
	 */
	function _isProtocolAllowed(bytes32 _protocol) internal view returns (bool) {
		return ICoreWhitelist(ufarmCore()).isProtocolWhitelisted(_protocol);
	}

	/**
	 * @notice Checks if token is allowed to be used in the pool
	 * @param token - token to check
	 * @return true if token is allowed, false otherwise
	 */
	function isTokenAllowed(address token) public view virtual returns (bool) {
		return ICoreWhitelist(ufarmCore()).isTokenWhitelisted(token);
	}

	uint256[50] private __gap;
}
