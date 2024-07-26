// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {BeaconProxy} from '@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol';

/**
 * @title SafeOPS
 * @author https://ufarm.digital/
 * @notice Contract module which provides a safe wrappers for some external calls
 */
library SafeOPS {
	error DelegateCallFailed(address to);
	error StaticCallFailed(address to);
	error CallFailed(address to);
	error ETHTransferFailed();
	error BeaconProxyDeployFailed();

	function _forceApprove(address token, address spender, uint256 value) internal {
		bytes memory approvalCall = abi.encodeCall(IERC20.approve, (spender, value));

		(bool success, ) = _safeCall(token, approvalCall);
		if (!success) {
			_safeCall(token, abi.encodeCall(IERC20.approve, (spender, 0)));
			_safeCall(token, approvalCall);
		}
	}

	function _safeCall(
		address _to,
		bytes memory _data
	) internal returns (bool success, bytes memory result) {
		(success, result) = _to.call(_data);
		if (!success) {
			if (result.length > 0) {
				// solhint-disable-next-line no-inline-assembly
				assembly {
					let data_size := mload(result)
					revert(add(32, result), data_size)
				}
			} else revert CallFailed(_to);
		}
	}

	function _safeStaticCall(
		address _to,
		bytes calldata _data
	) internal view returns (bool success, bytes memory result) {
		(success, result) = _to.staticcall(_data);
		if (!success) {
			if (result.length > 0) {
				// solhint-disable-next-line no-inline-assembly
				assembly {
					let data_size := mload(result)
					revert(add(32, result), data_size)
				}
			} else revert StaticCallFailed(_to);
		}
	}

	function _safeDelegateCall(
		bool _ignoreRevert,
		address _to,
		bytes memory _data
	) internal returns (bool success, bytes memory result) {
		/// @custom:oz-upgrades-unsafe-allow delegatecall
		(success, result) = _to.delegatecall(_data);
		if (!success && !_ignoreRevert) {
			if (result.length > 0) {
				// solhint-disable-next-line no-inline-assembly
				assembly {
					let data_size := mload(result)
					revert(add(32, result), data_size)
				}
			} else revert DelegateCallFailed(_to);
		}
	}

	function _safeTransferETH(address _to, uint256 _amount) internal {
		/// @solidity memory-safe-assembly
		assembly {
			if iszero(call(gas(), _to, _amount, gas(), 0x00, gas(), 0x00)) {
				mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`.
				revert(0x1c, 0x04)
			}
		}
	}

	function _safeBeaconCreate2Deploy(
		address _beacon,
		bytes32 _salt,
		bytes memory _initCall
	) internal returns (address addr) {
		try new BeaconProxy{salt: _salt}(_beacon, _initCall) returns (BeaconProxy beaconProxy) {
			return address(beaconProxy);
		} catch {
			revert BeaconProxyDeployFailed();
		}
	}

	function computeBeaconProxyAddress(
		address _implBeacon,
		bytes32 _salt,
		bytes memory _initCall
	) internal view returns (address addr) {
		return
			address(
				uint160(
					uint(
						keccak256(
							abi.encodePacked(
								bytes1(0xff),
								address(this),
								_salt,
								keccak256(
									abi.encodePacked(
										type(BeaconProxy).creationCode,
										abi.encode(_implBeacon, _initCall)
									)
								)
							)
						)
					)
				)
			);
	}
}
