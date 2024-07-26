// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// CONTRACTS
import {UFarmErrors} from './UFarmErrors.sol';
import {NZGuard} from './NZGuard.sol';
import {OwnableUpgradeable} from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';

/**
 * @title UFarmOwnableUUPS contract
 * @author https://ufarm.digital/
 * @notice UUPS + Ownable contract for permissioned upgrades
 */
abstract contract UFarmOwnableUUPS is OwnableUpgradeable, UUPSUpgradeable {
	/// @dev Address of the contract deployer, used for delayed permissioned initialization
	/// @custom:oz-upgrades-unsafe-allow state-variable-assignment state-variable-immutable
	address private immutable _deployer = msg.sender;
	/// @custom:oz-upgrades-unsafe-allow state-variable-assignment state-variable-immutable
	address private immutable __self = address(this);

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
	 * @dev Modifier to check if function is called by the deployer.
	 */
	modifier onlyDeployer() {
		if (msg.sender != _deployer) revert UFarmErrors.NonAuthorized();
		_;
	}

	/**
	 * @notice Prohibits renouncing ownership to prevent potential state with no owner
	 */
	function renounceOwnership() public pure override {
		revert UFarmErrors.NonAuthorized();
	}

	function __init__UFarmOwnableUUPS() internal virtual onlyInitializing {
		__Ownable_init();
	}

	function __init_UFarmOwnableUUPS_unchained() internal virtual onlyInitializing {}

	function _authorizeUpgrade(address newImplementation) internal virtual override onlyOwner {}

	uint256[50] private __gap;
}
