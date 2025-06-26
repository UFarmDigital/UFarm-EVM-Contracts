// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {UFarmOwnableUUPS} from "../../../shared/UFarmOwnableUUPS.sol";
import {UFarmPermissionsModel} from "../../permissions/UFarmPermissionsModel.sol";
import {Permissions} from "../../permissions/Permissions.sol";
import {UFarmCoreLink} from "../../../shared/UFarmCoreLink.sol";

contract Guard is UFarmOwnableUUPS, UFarmCoreLink {
	mapping(bytes32 => mapping(address => mapping(bytes4 => bool))) private allowedMethods;

	/**
	 * @notice Emitted on whitelisting the dapp
	 * @param dapp - dapp id (hash of dapp's domain)
	 * @param target - target address of the contract
	 * @param method - selector of the modified method
	 * @param isAllowed - flag of whitelisting: allow/deny
	 */
    event WhitelistUpdated(bytes32 indexed dapp, address indexed target, bytes4 method, bool isAllowed);

    error MismatchedArrayLengths();

	/**
	 * @notice Ensures the caller is either the owner or has two specific permissions.
	 * @param permission1 The first required permission.
	 * @param permission2 The second required permission.
	 */
    modifier ownerOrHaveTwoPermissions(uint8 permission1, uint8 permission2) {
		UFarmPermissionsModel core = UFarmPermissionsModel(UFarmCoreLink(address(this)).ufarmCore());
		if (!core.hasPermission(msg.sender, uint8(Permissions.UFarm.Owner))) {
			core.checkForPermissionsMask(msg.sender, core.twoPermissionsToMask(permission1, permission2));
		}
		_;
	}

    /**
	 * @notice Initializes the Guard contract.
	 * @dev Can only be called once by the deployer.
	 * @param ufarmCore The address of the UFarmCore contract.
	 */
	function __init__Guard(address ufarmCore) external initializer onlyDeployer {
		__init__UFarmOwnableUUPS();
        __init__UFarmCoreLink(ufarmCore);
	}

    /**
	 * @notice Checks if a specific method is allowed for a given dApp & dApp pool (dappAddress).
	 * @param dapp The identifier of the dApp.
	 * @param dappAddress The address of the dApp.
	 * @param payload The calldata containing the method selector.
	 * @return True if the method is allowed, false otherwise.
	 */
	function isProtocolAllowed(
		bytes32 dapp,
		address dappAddress,
		bytes calldata payload
	) external view returns (bool) {
		bytes4 method;
		assembly {
			method := calldataload(payload.offset)
		}
		return _isMethodAllowed(dapp, dappAddress, method);
	}

     /**
	 * @notice Checks if a specific method is allowed for a given dApp & dApp pool (dappAddress).
	 * @param dapp The identifier of the dApp.
	 * @param dappAddress The address of the dApp.
	 * @param method The method selector to check.
	 * @return True if the method is allowed, false otherwise.
	 */
    function isMethodAllowed(
		bytes32 dapp,
		address dappAddress,
		bytes4 method
	) external view returns (bool) {
		return _isMethodAllowed(dapp, dappAddress, method);
	}

    /**
	 * @notice Adds allowed methods for a given dApp and its associated addresses.
	 * @dev Only callable by the owner or users with `Member` and `ManageWhitelist` permissions.
	 * @param dapp The identifier of the dApp.
	 * @param dappAddresses The addresses associated with the dApp.
	 * @param methods The method selectors to allow.
	 */
    function addAllowedMethods(
        bytes32 dapp,
        address[] calldata dappAddresses,
        bytes4[] calldata methods
    )
        external
        ownerOrHaveTwoPermissions(
            uint8(Permissions.UFarm.Member),
            uint8(Permissions.UFarm.ManageWhitelist)
        )
    {
        _modifyAllowedMethods(dapp, dappAddresses, methods, true);
    }

    /**
	 * @notice Removes allowed methods for a given dApp and its associated addresses.
	 * @dev Only callable by the owner or users with `Member` and `ManageWhitelist` permissions.
	 * @param dapp The identifier of the dApp.
	 * @param dappAddresses The addresses associated with the dApp.
	 * @param methods The method selectors to remove.
	 */
    function removeAllowedMethods(
        bytes32 dapp,
        address[] calldata dappAddresses,
        bytes4[] calldata methods
    )
        external
        ownerOrHaveTwoPermissions(
            uint8(Permissions.UFarm.Member),
            uint8(Permissions.UFarm.ManageWhitelist)
        )
    {
        _modifyAllowedMethods(dapp, dappAddresses, methods, false);
    }

    /**
	 * @notice Modifies the allowed status of specific methods for a dApp.
	 * @dev Internal function used by `addAllowedMethods` and `removeAllowedMethods`.
	 * @param dapp The identifier of the dApp.
	 * @param dappAddresses The addresses associated with the dApp.
	 * @param methods The method selectors to modify.
	 * @param isAllowed Boolean flag indicating whether to allow or deny the methods.
	 */
    function _modifyAllowedMethods(
        bytes32 dapp,
        address[] calldata dappAddresses,
        bytes4[] calldata methods,
        bool isAllowed
    )
        internal
    {
        if (dappAddresses.length == 0 || methods.length == 0) {
            revert MismatchedArrayLengths();
        }

        for (uint256 i = 0; i < dappAddresses.length; i++) {
            for (uint256 j = 0; j < methods.length; j++) {
                allowedMethods[dapp][dappAddresses[i]][methods[j]] = isAllowed;
                emit WhitelistUpdated(dapp, dappAddresses[i], methods[j], isAllowed);
            }
        }
    }

     /**
	 * @notice Checks if a specific method is allowed for a given dApp & dApp pool (dappAddress).
	 * @param dapp The identifier of the dApp.
	 * @param dappAddress The address of the dApp.
	 * @param method The method selector to check.
	 * @return True if the method is allowed, false otherwise.
	 */
    function _isMethodAllowed(
		bytes32 dapp,
		address dappAddress,
		bytes4 method
	) internal view returns (bool) {
        return
            allowedMethods[0x0][dappAddress][0x0] ||    // all methods for all dapps
            allowedMethods[dapp][dappAddress][0x0] ||   // all methods for specific dapp
            allowedMethods[0x0][dappAddress][method] || // specific method for all dapps
            allowedMethods[dapp][dappAddress][method];  // specific method for specific dapp
	}


	uint256[50] private __gap;
    
}
