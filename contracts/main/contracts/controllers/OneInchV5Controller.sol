// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

/// CONTRACTS
import {UFarmErrors} from '../../shared/UFarmErrors.sol';
import {NZGuard} from '../../shared/NZGuard.sol';
import {Controller, IController} from './Controller.sol';
import {SafeOPS} from '../../shared/SafeOPS.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

/// INTERFACES
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {ICoreWhitelist} from '../core/ICoreWhitelist.sol';
import {IPoolWhitelist} from '../pool/PoolWhitelist.sol';
import {IUniswapV2Pair} from '../../../test/Uniswap/contracts/v2-core/contracts/interfaces/IUniswapV2Pair.sol';

/// LIBRARIES
import {BytesLib} from '../../../test/UniswapV3/@uniswap/v3-periphery/contracts/libraries/BytesLib.sol';

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
		address srcToken,
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

/**
 * @title 1Inch V5 Controller contract
 * @author https://ufarm.digital/
 * @notice Controller contract for 1Inch V5 aggregation router
 */
contract OneInchV5Controller is Controller, NZGuard, UFarmErrors, ReentrancyGuard {
	using BytesLib for bytes;

	bytes32 internal constant _PROTOCOL = keccak256(abi.encodePacked('OneInchV5'));

	/// @notice 1inch V5 aggregation router address
	address public immutable aggregationRouterV5;

	constructor(address _aggregationRouterV5) {
		aggregationRouterV5 = _aggregationRouterV5;
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
		bytes32 indexed protocol
	);

	error EmptySwapPath();
	error InvalidPath();
	error InvalidMethod();
	error InvalidRecipient();
	error OneInchSwapFailed();

	/**
	 * @inheritdoc IController
	 */
	function PROTOCOL() public pure override returns (bytes32) {
		return _PROTOCOL;
	}

	/**
	 * @notice Executes multiple swaps one by one using 1inch V5 aggregation router
	 * @param _multiData - array of bytes data for multiple swaps
	 */
	function delegated1InchMultiSwap(
		bytes[] calldata _multiData
	) external checkDelegateCall nonReentrant {
		uint256 swapsCount = _multiData.length;
		if (swapsCount == 0) revert EmptySwapPath();

		(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) = _run1InchSwap(
			_multiData[0]
		);

		for (uint256 i = 1; i < swapsCount; ++i) {
			(, tokenOut, , amountOut) = _run1InchSwap(_multiData[i]);
		}

		_afterSwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
	}

	/**
	 * @notice Executes swap using 1inch V5 aggregation router
	 * @param _data - swap transaction data
	 */
	function delegated1InchSwap(bytes calldata _data) public checkDelegateCall nonReentrant {
		(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) = _run1InchSwap(_data);
		_afterSwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
	}

	function _run1InchSwap(
		bytes memory _data
	) internal returns (address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) {
		bytes4 method;
		assembly {
			method := mload(add(_data, 32)) // load first 4 bytes of data
		}

		uint256[] memory pools;

		if (method == IAggregationRouterV5.unoswapTo.selector) {
			address payable recipient;
			address localTokenIn;
			(recipient, localTokenIn, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, address, uint256, uint256, uint256[])
			);

			if (recipient != address(this)) revert InvalidRecipient();

			tokenIn = localTokenIn;

			_onlyIfTokenAllowed(localTokenIn);

			address v2Pool;
			for (uint256 i; i < pools.length; ++i) {
				v2Pool = address(uint160(pools[i]));

				(address token0, address token1) = (
					IUniswapV2Pair(v2Pool).token0(),
					IUniswapV2Pair(v2Pool).token1()
				);

				if (token0 == localTokenIn) {
					localTokenIn = token1;
				} else if (token1 == localTokenIn) {
					localTokenIn = token0;
				} else revert InvalidPath();
				_onlyIfTokenAllowed(localTokenIn);
			}
			tokenOut = localTokenIn;
		} else if (method == IAggregationRouterV5.unoswap.selector) {
			address localTokenIn;
			(localTokenIn, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, uint256, uint256, uint256[])
			);

			tokenIn = localTokenIn;

			_onlyIfTokenAllowed(localTokenIn);

			address v2Pool;
			for (uint256 i; i < pools.length; ++i) {
				v2Pool = address(uint160(pools[i]));

				(address token0, address token1) = (
					IUniswapV2Pair(v2Pool).token0(),
					IUniswapV2Pair(v2Pool).token1()
				);

				if (token0 == localTokenIn) {
					localTokenIn = token1;
				} else if (token1 == localTokenIn) {
					localTokenIn = token0;
				} else revert InvalidPath();
				_onlyIfTokenAllowed(localTokenIn);
			}
			tokenOut = localTokenIn;
		} else if (method == IAggregationRouterV5.uniswapV3SwapTo.selector) {
			address payable recipient;
			(recipient, amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, uint256, uint256, uint256[])
			);

			if (recipient != address(this)) revert InvalidRecipient();

			uint256 length = pools.length;
			for (uint256 i; i < length; ++i) {
				address v2Pool = address(uint160(pools[i]));

				bool zeroForOne = pools[i] & (1 << 255) == 0;

				(address token0, address token1) = (
					IUniswapV3Pool(v2Pool).token0(),
					IUniswapV3Pool(v2Pool).token1()
				);
				if (i > 0) {
					// get dst token
					tokenOut = zeroForOne ? token1 : token0;
				} else {
					(tokenIn, tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
					// check src token if it's first pool
					_onlyIfTokenAllowed(tokenIn);
				}
				// check dst token
				_onlyIfTokenAllowed(tokenOut);
			}
		} else if (method == IAggregationRouterV5.uniswapV3Swap.selector) {
			(amountIn, amountOut, pools) = abi.decode(
				_data.slice(4, _data.length - 4),
				(uint256, uint256, uint256[])
			);

			uint256 length = pools.length;
			for (uint256 i; i < length; ++i) {
				address v2Pool = address(uint160(pools[i]));

				bool zeroForOne = pools[i] & (1 << 255) == 0;

				(address token0, address token1) = (
					IUniswapV3Pool(v2Pool).token0(),
					IUniswapV3Pool(v2Pool).token1()
				);
				if (i > 0) {
					// get dst token
					tokenOut = zeroForOne ? token1 : token0;
				} else {
					(tokenIn, tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
					// check src token if it's first pool
					_onlyIfTokenAllowed(tokenIn);
				}
				// check dst token
				_onlyIfTokenAllowed(tokenOut);
			}
		} else if (method == IAggregationRouterV5.swap.selector) {
			IAggregationRouterV5.SwapDescription memory swapDescription;
			(, swapDescription) = abi.decode(
				_data.slice(4, _data.length - 4),
				(address, IAggregationRouterV5.SwapDescription)
			);

			tokenIn = swapDescription.srcToken;
			tokenOut = swapDescription.dstToken;
			amountIn = swapDescription.amount;
			amountOut = swapDescription.minReturnAmount;

			if (swapDescription.dstReceiver != address(this)) revert InvalidRecipient();
			_onlyIfTokenAllowed(tokenOut);
		} else revert InvalidMethod();

		if (amountIn == 0 || amountOut == 0) revert OneInchSwapFailed();

		SafeOPS._forceApprove(tokenIn, aggregationRouterV5, amountIn);

		(, bytes memory result) = SafeOPS._safeCall(aggregationRouterV5, _data);

		uint256 amountOutResult;
		assembly {
			// return amount should be in 0x20 offset from any result
			amountOutResult := mload(add(result, 0x20))
		}

		if (amountOutResult < amountOut) revert OneInchSwapFailed();
		amountOut = amountOutResult;
	}

	function _afterSwapExecuted(
		address tokenIn,
		address tokenOut,
		uint256 amountIn,
		uint256 amountOut
	) internal {
		IUFarmPool(address(this)).removeERC20(tokenIn);
		IUFarmPool(address(this)).addERC20(tokenOut, bytes32(0));
		emit SwapOneInchV5(tokenIn, tokenOut, amountIn, amountOut, PROTOCOL());
	}

	function _onlyIfTokenAllowed(address token) internal view {
		if (IPoolWhitelist(address(this)).isTokenAllowed(token) == false &&
			token != 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
		) {
			revert IPoolWhitelist.TokenIsNotAllowed(token);
		}
	}
}
