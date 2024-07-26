// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {UFarmErrors} from '../../shared/UFarmErrors.sol';

/**
 * @title UFarmPermissionsModel contract
 * @author https://ufarm.digital/
 * @notice Contract that implements permissions model for UFarm contracts
 */
abstract contract UFarmPermissionsModel {
	uint256 internal constant _FULL_PERMISSIONS_MASK = type(uint256).max;
	mapping(address => uint256) internal _accountMask;

	// EVENTS
	event PermissionsUpdated(address account, uint256 newPermissions);

	// ERRORS
	error PermissionAlreadyGranted(address account, uint256 permissions);

	// MODIFIERS
	/**
	 * @notice Reverts if account has no required permissions
	 * @param account - address to check permissions
	 * @param permission1 - first permission to check
	 * @param permission2 - second permission to check
	 */
	modifier shouldHaveTwoPermissions(
		address account,
		uint8 permission1,
		uint8 permission2
	) {
		_checkForPermissions(account, _twoPermissionsToMask(permission1, permission2));
		_;
	}

	// PUBLIC

	/**
	 * @notice Returns 'true' if account has required permission, 'false' otherwise
	 * @param account - address to check permissions
	 * @param permissionToCheck - permission to check
	 */
	function hasPermission(
		address account,
		uint8 permissionToCheck
	) external view virtual returns (bool) {
		return _hasPermission(account, permissionToCheck);
	}

	/**
	 * @notice Returns 'true' if account has required permissions mask, 'false' otherwise
	 * @param account - address to check permissions
	 * @param permissionsToCheck - permissions mask to compare with
	 */
	function hasPermissionsMask(
		address account,
		uint256 permissionsToCheck
	) external view virtual returns (bool) {
		return __hasPermissions(_accountMask[account], permissionsToCheck);
	}

	/**
	 * @notice Reverts if account has no required permissions mask
	 * @param account - address to check permissions
	 * @param permissionsToCheck - permissions mask to compare with
	 */
	function checkForPermissionsMask(
		address account,
		uint256 permissionsToCheck
	) external view virtual {
		_checkForPermissions(account, permissionsToCheck);
	}

	// INTERNAL SETTERS

	function _updatePermissions(address account, uint256 newPermissions) internal {
		if (_accountMask[account] != newPermissions) {
			_accountMask[account] = newPermissions;
			emit PermissionsUpdated(account, newPermissions);
		} else {
			revert PermissionAlreadyGranted(account, newPermissions);
		}
	}

	// INTERNAL CHECKS

	function _checkForPermissions(address account, uint256 permissions) internal view {
		if (!__hasPermissions(_accountMask[account], permissions)) {
			revert UFarmErrors.NonAuthorized();
		}
	}

	// INTERNAL GETTERS

	function _hasPermission(address account, uint8 permissionToCheck) internal view returns (bool) {
		return (_accountMask[account] & (1 << permissionToCheck)) != 0;
	}

	function _maskHasPermission(uint256 mask, uint8 permissionToCheck) internal pure returns (bool) {
		return (mask & (1 << permissionToCheck)) != 0;
	}

	function _hasPermissionMask(
		address account,
		uint256 permissionToCheck
	) internal view returns (bool) {
		return (_accountMask[account] & permissionToCheck) == permissionToCheck;
	}

	function _isPermissionDiff(
		uint8 permission,
		uint256 mask1,
		uint256 mask2
	) internal pure returns (bool) {
		return ((mask1 & (1 << permission)) != (mask2 & (1 << permission)));
	}

	function _permissionToMask(uint8 permission) internal pure returns (uint256 mask) {
		return (1 << permission);
	}

	function _twoPermissionsToMask(
		uint8 permission1,
		uint8 permission2
	) internal pure returns (uint256 mask) {
		return (1 << permission1) | (1 << permission2);
	}

	function __hasPermissions(uint256 accountPermissions, uint256 mask) private pure returns (bool) {
		return (accountPermissions & mask) == mask;
	}

	uint256[50] private __gap;
}
