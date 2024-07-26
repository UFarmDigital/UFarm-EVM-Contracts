// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// @title NZGuard contract contains modifiers to check inputs for non-zero address, non-zero value, non-same address, non-same value, and non-more-than-one
abstract contract NZGuard {
	error ZeroAddress();
	error ZeroValue();
	error EmptyArray();
	error SameAddress();
	error SameValue();
	error MoreThanOne();
	error ValueNotInRange(uint256 _value, uint256 _min, uint256 _max);

	modifier nonZeroAddress(address _address) {
		_nonZeroAddress(_address);
		_;
	}
	modifier nonZeroValue(uint256 _value) {
		_nonZeroValue(_value);
		_;
	}
	modifier nonSameValue(uint256 _value1, uint256 _value2) {
		_nonSameValue(_value1, _value2);
		_;
	}
	modifier nonZeroBytes32(bytes32 _value) {
		_nonZeroBytes32(_value);
		_;
	}
	modifier nonSameAddress(address _address1, address _address2) {
		_nonSameAddress(_address1, _address2);
		_;
	}
	modifier nonMoreThenOne(uint256 _value) {
		_nonMoreThenOne(_value);
		_;
	}
	modifier nonEmptyArray(uint256 arrLength) {
		_nonEmptyArray(arrLength);
		_;
	}
	modifier valueInRange(
		uint256 _value,
		uint256 _min,
		uint256 _max
	) {
		_valueInRange(_value, _min, _max);
		_;
	}

	function _nonZeroAddress(address _address) internal pure {
		if (_address == address(0)) {
			revert ZeroAddress();
		}
	}

	function _nonZeroValue(uint256 _value) internal pure {
		if (_value == 0) {
			revert ZeroValue();
		}
	}

	function _nonZeroBytes32(bytes32 _value) internal pure {
		if (_value == bytes32(0)) {
			revert ZeroValue();
		}
	}

	function _nonSameAddress(address _address1, address _address2) internal pure {
		if (_address1 == _address2) {
			revert SameAddress();
		}
	}

	function _nonSameValue(uint256 _value1, uint256 _value2) internal pure {
		if (_value1 == _value2) {
			revert SameValue();
		}
	}

	function _nonMoreThenOne(uint256 _value) internal pure {
		if (_value > 1e18) {
			revert MoreThanOne();
		}
	}

	function _nonEmptyArray(uint256 arrLength) internal pure {
		if (arrLength == 0) {
			revert EmptyArray();
		}
	}

	function _valueInRange(uint256 _value, uint256 _min, uint256 _max) internal pure {
		if (_value < _min || _value > _max) {
			revert ValueNotInRange(_value, _min, _max);
		}
	}
}
