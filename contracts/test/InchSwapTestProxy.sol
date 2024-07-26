// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import {IUFarmCore} from '../main/contracts/core/IUFarmCore.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// LIBRARIES
import {EnumerableSet} from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import {SafeOPS} from '../main/shared/SafeOPS.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {UFarmErrors} from '../main/shared/UFarmErrors.sol';
import {NZGuard} from '../main/shared/NZGuard.sol';
import {Controller, IController} from '../main/contracts/controllers/Controller.sol';
import {SafeOPS} from '../main/shared/SafeOPS.sol';
import {IUniswapV2Pair} from './Uniswap/contracts/v2-core/contracts/interfaces/IUniswapV2Pair.sol';
import {BytesLib} from './UniswapV3/@uniswap/v3-periphery/contracts/libraries/BytesLib.sol';

interface IAggregationExecutor {
	/// @notice propagates information about original msg.sender and executes arbitrary data
	function execute(address msgSender) external payable; // 0x4b64e492
}

interface IAggregationRouterV5 {
	struct SwapDescription {
		address srcToken;
		address dstToken;
		address payable srcReceiver;
		address payable dstReceiver;
		uint256 amount;
		uint256 minReturnAmount;
		uint256 flags;
	}

	function swap(
		IAggregationExecutor executor,
		SwapDescription calldata desc,
		bytes calldata permit,
		bytes calldata data
	) external payable returns (uint256 returnAmount, uint256 spentAmount);

	function unoswap(
		address srcToken,
		uint256 amount,
		uint256 minReturn,
		uint256[] calldata pools
	) external payable returns (uint256 returnAmount);

	function unoswapTo(
		address payable recipient,
		IERC20 srcToken,
		uint256 amount,
		uint256 minReturn,
		uint256[] calldata pools
	) external payable returns (uint256 returnAmount);

	function uniswapV3Swap(
		uint256 amount,
		uint256 minReturn,
		uint256[] calldata pools
	) external payable returns (uint256 returnAmount);

	function uniswapV3SwapTo(
		address payable recipient,
		uint256 amount,
		uint256 minReturn,
		uint256[] calldata pools
	) external payable returns (uint256 returnAmount);
}

interface IUniswapV3Pool {
	function token0() external view returns (address);

	function token1() external view returns (address);
}

contract InchSwapTestProxy {
	mapping(bytes32 => address) public controllers;

	function addController(bytes32 _protocol, address _controller) external {
		controllers[_protocol] = _controller;
	}

	function justCall(address token, address callAddr, bytes calldata callData) public {
		SafeOPS._forceApprove(token, callAddr, 1000 * 1 ether);
		(bool success, bytes memory result) = callAddr.call(callData);
	}

	function protocolAction(bytes32 _protocol, bytes calldata _data) external {
		_protocolAction(false, controllers[_protocol], _protocol, address(this), _data);
	}

	function _protocolAction(
		bool _ignoreRevert,
		address _controllerAddr,
		bytes32 _protocolHash,
		address _target,
		bytes memory _data
	) private {
		SafeOPS._safeDelegateCall(_ignoreRevert, _controllerAddr, _data);
	}

	function executeAny(address _target, bytes calldata _data) external {
		(bool success, bytes memory result) = _target.delegatecall(_data);
		if (!success) {
			if (result.length > 0) {
				// solhint-disable-next-line no-inline-assembly
				assembly {
					let data_size := mload(result)
					revert(add(32, result), data_size)
				}
			} else revert('Call failed');
		}
	}
}

contract InchSwapTestController is Controller, NZGuard, UFarmErrors {
	using BytesLib for bytes;

	bytes32 internal constant _PROTOCOL = keccak256(abi.encodePacked('OneInchV5')); // Needs to be hardcoded in the contract to use it during delegation

	address public aggregationRouterV5;
	address public immutable thisAddr;

	constructor(address _aggregationRouterV5) {
		aggregationRouterV5 = _aggregationRouterV5;
		thisAddr = address(this);
	}

	/**
	 * @notice Delegates swap to 1inch V5 aggregation router
	 * @param tokenIn - token to swap from
	 * @param tokenOut - token to swap to
	 * @param amountIn - amount of tokenIn to swap
	 * @param amountOut - minimum amount of tokenOut to receive
	 * @param protocol - protocol hashed name
	 */
	event SwapOneInchV5(
		address indexed tokenIn,
		address indexed tokenOut,
		uint256 amountIn,
		uint256 amountOut,
		bytes32 protocol
	);

	error InvalidPath();
	error InvalidMethod(bytes4 method);
	error InvalidRecipient();
	error OneInchSwapFailed();

	/**
	 * @inheritdoc IController
	 */
	function PROTOCOL() public pure override returns (bytes32) {
		return _PROTOCOL;
	}

	// IAggregationRouterV5.unoswap(srcToken: 0xdAC17F958D2ee523a2206206994597C13D831ec7, amount: 996999, minReturn: 988205, pools: [57896044618658097713242609637998371593005199524156639266814448023762806431658])
	// OneInchV5Controller.delegated1InchSwap(_data: 0x0502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000f368700000000000000000000000000000000000000000000000000000000000f142d0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d0340d86a120a06255df8d4e2248ab04d4267e23adfaa8b1ccac8)
	function delegated1InchSwap(bytes memory _data) external checkDelegateCall {
		bytes4 method;
		assembly {
			method := mload(add(_data, 32)) // load first 4 bytes of data
		}

		uint256[] memory pools;
		address srcToken;
		address payable recipient;
		uint256 amountIn;
		uint256 amountOut;
		address tokenIn;
		address tokenOut;

		if (method == IAggregationRouterV5.unoswapTo.selector) {
			(recipient, srcToken, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, address, uint256, uint256, uint256[])
			);

			if (recipient != address(this)) revert InvalidRecipient();

			tokenIn = srcToken;

			// _onlyIfTokenAllowed(srcToken);

			address v2Pool;
			for (uint256 i; i < pools.length; ++i) {
				v2Pool = address(uint160(pools[i]));

				(address token0, address token1) = (
					IUniswapV2Pair(v2Pool).token0(),
					IUniswapV2Pair(v2Pool).token1()
				);

				if (token0 == srcToken) {
					// _onlyIfTokenAllowed(token1);
					srcToken = token1;
				} else if (token1 == srcToken) {
					// _onlyIfTokenAllowed(token0);
					srcToken = token0;
				} else revert InvalidPath();
			}
			tokenOut = srcToken;
		} else if (method == IAggregationRouterV5.uniswapV3SwapTo.selector) {
			(recipient, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, uint256, uint256, uint256[])
			);

			if (recipient != address(this)) revert InvalidRecipient();

			uint256 length = pools.length;
			for (uint256 i; i < length; ++i) {
				address v2Pool = address(uint160(pools[i]));

				bool zeroForOne = pools[0] & (1 << 255) == 0;

				(address token0, address token1) = (
					IUniswapV3Pool(v2Pool).token0(),
					IUniswapV3Pool(v2Pool).token1()
				);
				if (i == 0) {
					if (length == 1) {
						tokenOut = zeroForOne ? token1 : token0;
						// _onlyIfTokenAllowed(tokenOut);
					}
					// check src token
					tokenIn = zeroForOne ? token0 : token1;
					// _onlyIfTokenAllowed(tokenIn);
				} else if (i < length) {
					// check next dst token
					// _onlyIfTokenAllowed(zeroForOne ? token1 : token0);
				} else {
					// check dst token
					tokenOut = zeroForOne ? token1 : token0;
					// _onlyIfTokenAllowed(tokenOut);
				}
			}
		} else if (method == IAggregationRouterV5.unoswap.selector) {
			(srcToken, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, uint256, uint256, uint256[])
			);

			tokenIn = srcToken;

			// _onlyIfTokenAllowed(srcToken);

			address v2Pool;
			for (uint256 i; i < pools.length; ++i) {
				v2Pool = address(uint160(pools[i]));

				(address token0, address token1) = (
					IUniswapV2Pair(v2Pool).token0(),
					IUniswapV2Pair(v2Pool).token1()
				);

				if (token0 == srcToken) {
					// _onlyIfTokenAllowed(token1);
					srcToken = token1;
				} else if (token1 == srcToken) {
					// _onlyIfTokenAllowed(token0);
					srcToken = token0;
				} else revert InvalidPath();
			}
			tokenOut = srcToken;
		} else revert InvalidMethod(method);

		address _aggregRouter = InchSwapTestController(payable(thisAddr)).aggregationRouterV5();

		if (amountIn == 0 || amountOut == 0) revert OneInchSwapFailed();

		SafeOPS._forceApprove(tokenIn, _aggregRouter, amountIn);

		// uint256 balanceIn = IERC20(tokenIn).balanceOf(address(this));

		// emit Data(_data);

		(, bytes memory result) = SafeOPS._safeCall(_aggregRouter, _data);

		uint256 amountOutResult;
		assembly {
			// return amount should be in 0x20 offset from any result
			amountOutResult := mload(add(result, 0x20))
		}

		if (amountOutResult < amountOut) revert OneInchSwapFailed();

		emit SwapOneInchV5(tokenIn, tokenOut, amountIn, amountOutResult, PROTOCOL());
	}
}
