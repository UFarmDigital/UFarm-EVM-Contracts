// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {NZGuard} from '../../shared/NZGuard.sol';
import {UFarmErrors} from '../../shared/UFarmErrors.sol';
import {ICoreWhitelist} from './ICoreWhitelist.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/**
 * @title TokenWhitelist
 * @author https://ufarm.digital/
 * @notice Keeps track of all tokens that can be used in the system.
 */
abstract contract CoreWhitelist is ICoreWhitelist, NZGuard, UFarmErrors {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.Bytes32Set;

	mapping(bytes32 => address) public controllers;
	mapping(address => AssetWithPriceFeed) private _tokenInfo;

	EnumerableSet.AddressSet private __tokens;
	EnumerableSet.Bytes32Set private __protocols;

	event TokenAdded(AssetWithPriceFeed assetInfo);
	event TokenRemoved(address indexed token);
	event ProtocolAdded(bytes32 indexed protocol, address indexed controller);
	event ProtocolUpdated(bytes32 indexed protocol, address indexed controller);
	event ProtocolRemoved(bytes32 indexed protocol, address indexed controller);

	error DecimalsMismatch();
	error TokenAlreadyAdded(address token);
	error TokenNotRemoved(address token);
	error ProtocolNotAllowed(bytes32 protocol);

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function tokenInfo(
		address token
	) external view override returns (AssetWithPriceFeed memory info) {
		return _tokenInfo[token];
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function whitelistProtocolsWithControllers(
		bytes32[] memory _protocolNames,
		address[] memory _protocolControllers
	) public virtual override {
		uint256 controllersLength = _protocolControllers.length;

		if (_protocolNames.length != controllersLength) revert ArraysLengthMismatch();
		_nonEmptyArray(controllersLength);

		for (uint256 i; i < controllersLength; ++i) {
			address controller = _protocolControllers[i];
			bytes32 protocol = _protocolNames[i];
			if (controller == address(0)) revert ZeroAddress();
			if (protocol == bytes32(0)) revert ZeroValue();

			_whitelistProtocol(protocol, controller);
		}
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function updateProtocolsControllers(
		bytes32[] memory _protocolNames,
		address[] memory _protocolControllers
	) public virtual override {
		uint256 controllersLength = _protocolControllers.length;

		if (_protocolNames.length != controllersLength) revert ArraysLengthMismatch();
		_nonEmptyArray(controllersLength);

		address controller;
		bytes32 protocol;
		for (uint256 i; i < controllersLength; ++i) {
			controller = _protocolControllers[i];
			protocol = _protocolNames[i];
			_updateProtocol(protocol, controller);
		}
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function blacklistProtocols(bytes32[] memory _protocols) public virtual override {
		uint256 protocolsLength = _protocols.length;
		_nonEmptyArray(protocolsLength);

		for (uint256 i; i < protocolsLength; ++i) {
			bytes32 protocol = _protocols[i];
			_blacklistProtocol(protocol);
		}
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function getWhitelistedProtocols()
		external
		view
		virtual
		override
		returns (bytes32[] memory protocols)
	{
		return __protocols.values();
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function isTokenWhitelisted(address token) public view returns (bool) {
		return __tokens.contains(token);
	}

	function _whitelistTokens(AssetWithPriceFeed[] calldata tokens) internal {
		uint256 length = tokens.length;
		_nonEmptyArray(length);
		address token;
		uint8 decimals;
		AssetWithPriceFeed memory assetInfo;
		for (uint256 i; i < length; ++i) {
			assetInfo = tokens[i];
			token = assetInfo.assetAddr;
			if (__tokens.add(token)) {
				decimals = ERC20(token).decimals();
				if (decimals != assetInfo.assetDec) revert DecimalsMismatch();
				_tokenInfo[token] = assetInfo;
				emit TokenAdded(assetInfo);
			} else revert TokenAlreadyAdded(token);
		}
	}

	function _blacklistTokens(address[] memory tokens) internal {
		uint256 length = tokens.length;
		_nonEmptyArray(length);
		address token;
		for (uint256 i; i < length; ++i) {
			token = tokens[i];
			if (__tokens.remove(token)) {
				emit TokenRemoved(token);
			} else revert TokenNotRemoved(token);
		}
	}

	/**
	 * @inheritdoc ICoreWhitelist
	 */
	function isProtocolWhitelisted(bytes32 _protocol) external view virtual override returns (bool) {
		return _isProtocolWhitelisted(_protocol);
	}

	function _isProtocolWhitelisted(bytes32 _protocol) internal view returns (bool) {
		return __protocols.contains(_protocol);
	}

	function _getWhitelistedProtocols() internal view returns (bytes32[] memory protocols) {
		return __protocols.values();
	}

	function _whitelistProtocol(bytes32 _protocol, address _controller) internal {
		if (__protocols.add(_protocol)) {
			controllers[_protocol] = _controller;
			emit ProtocolAdded(_protocol, _controller);
		} else revert ActionAlreadyDone();
	}

	function _updateProtocol(
		bytes32 _protocol,
		address _controller
	) internal nonZeroBytes32(_protocol) {
		if (__protocols.contains(_protocol)) {
			controllers[_protocol] = _controller;
			emit ProtocolUpdated(_protocol, _controller);
		} else revert ProtocolNotAllowed(_protocol);
	}

	function _blacklistProtocol(bytes32 _protocol) internal nonZeroBytes32(_protocol) {
		if (__protocols.remove(_protocol)) {
			delete controllers[_protocol];
			emit ProtocolRemoved(_protocol, controllers[_protocol]);
		} else revert ActionAlreadyDone();
	}

	uint256[50] private __gap;
}
