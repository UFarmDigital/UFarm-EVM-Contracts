// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.15;

import {IUniswapV3Factory} from './UniswapV3/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol';
// import {IUniswapV3Pool} from './UniswapV3/@uniswap/v3-core/contracts/UniswapV3Pool.sol';
// import {INonfungiblePositionManager} from './UniswapV3/@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol';
import {INonfungiblePositionManager} from './UniswapV3/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol';
import {IQuoterV2} from './UniswapV3/@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol';
import 'hardhat/console.sol';

//

interface IERC20 {
	/**
	 * @dev Emitted when `value` tokens are moved from one account (`from`) to
	 * another (`to`).
	 *
	 * Note that `value` may be zero.
	 */
	event Transfer(address indexed from, address indexed to, uint256 value);

	/**
	 * @dev Emitted when the allowance of a `spender` for an `owner` is set by
	 * a call to {approve}. `value` is the new allowance.
	 */
	event Approval(address indexed owner, address indexed spender, uint256 value);

	/**
	 * @dev Returns the amount of tokens in existence.
	 */
	function totalSupply() external view returns (uint256);

	/**
	 * @dev Returns the amount of tokens owned by `account`.
	 */
	function balanceOf(address account) external view returns (uint256);

	/**
	 * @dev Moves `amount` tokens from the caller's account to `to`.
	 *
	 * Returns a boolean value indicating whether the operation succeeded.
	 *
	 * Emits a {Transfer} event.
	 */
	function transfer(address to, uint256 amount) external returns (bool);

	/**
	 * @dev Returns the remaining number of tokens that `spender` will be
	 * allowed to spend on behalf of `owner` through {transferFrom}. This is
	 * zero by default.
	 *
	 * This value changes when {approve} or {transferFrom} are called.
	 */
	function allowance(address owner, address spender) external view returns (uint256);

	/**
	 * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
	 *
	 * Returns a boolean value indicating whether the operation succeeded.
	 *
	 * IMPORTANT: Beware that changing an allowance with this method brings the risk
	 * that someone may use both the old and the new allowance by unfortunate
	 * transaction ordering. One possible solution to mitigate this race
	 * condition is to first reduce the spender's allowance to 0 and set the
	 * desired value afterwards:
	 * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
	 *
	 * Emits an {Approval} event.
	 */
	function approve(address spender, uint256 amount) external returns (bool);

	/**
	 * @dev Moves `amount` tokens from `from` to `to` using the
	 * allowance mechanism. `amount` is then deducted from the caller's
	 * allowance.
	 *
	 * Returns a boolean value indicating whether the operation succeeded.
	 *
	 * Emits a {Transfer} event.
	 */
	function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IWETH is IERC20 {
	function deposit() external payable;

	function withdraw(uint256 amount) external;
}

interface IUniswapV3PoolTest {
	// interface IUniswapV3PoolImmutables
	/// @notice The contract that deployed the pool, which must adhere to the IUniswapV3Factory interface
	/// @return The contract address
	function factory() external view returns (address);

	/// @notice The first of the two tokens of the pool, sorted by address
	/// @return The token contract address
	function token0() external view returns (address);

	/// @notice The second of the two tokens of the pool, sorted by address
	/// @return The token contract address
	function token1() external view returns (address);

	/// @notice The pool's fee in hundredths of a bip, i.e. 1e-6
	/// @return The fee
	function fee() external view returns (uint24);

	/// @notice The pool tick spacing
	/// @dev Ticks can only be used at multiples of this value, minimum of 1 and always positive
	/// e.g.: a tickSpacing of 3 means ticks can be initialized every 3rd tick, i.e., ..., -6, -3, 0, 3, 6, ...
	/// This value is an int24 to avoid casting even though it is always positive.
	/// @return The tick spacing
	function tickSpacing() external view returns (int24);

	/// @notice The maximum amount of position liquidity that can use any tick in the range
	/// @dev This parameter is enforced per tick to prevent liquidity from overflowing a uint128 at any point, and
	/// also prevents out-of-range liquidity from being used to prevent adding in-range liquidity to a pool
	/// @return The max amount of liquidity per tick
	function maxLiquidityPerTick() external view returns (uint128);
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

	// function swap(
	// 	IAggregationExecutor executor,
	// 	SwapDescription calldata desc,
	// 	bytes calldata permit,
	// 	bytes calldata data
	// ) external payable returns (uint256 returnAmount, uint256 spentAmount);

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

contract OneInchToUfarmTestEnv {
	address private constant _NATIVE_ASSET = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

	uint256 private constant _ONE_FOR_ZERO_MASK = 1 << 255;
	uint256 private constant _WETH_UNWRAP_MASK = 1 << 253;
	bytes32 private constant _POOL_INIT_CODE_HASH =
		0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
	bytes32 private constant _FF_FACTORY =
		0xff1F98431c8aD98523631AE4a59f267346ea31F9840000000000000000000000;
	// concatenation of token0(), token1() fee(), transfer() and transferFrom() selectors
	bytes32 private constant _SELECTORS =
		0x0dfe1681d21220a7ddca3f43a9059cbb23b872dd000000000000000000000000;
	uint256 private constant _ADDRESS_MASK =
		0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff;
	/// @dev The minimum value that can be returned from #getSqrtRatioAtTick. Equivalent to getSqrtRatioAtTick(MIN_TICK)
	uint160 private constant _MIN_SQRT_RATIO = 4295128739 + 1;
	/// @dev The maximum value that can be returned from #getSqrtRatioAtTick. Equivalent to getSqrtRatioAtTick(MAX_TICK)
	uint160 private constant _MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342 - 1;
	IWETH private immutable _WETH; // solhint-disable-line var-name-mixedcase

	constructor(IWETH weth) {
		_WETH = weth;
	}

	//

	//

	//

	struct UniswapV3CustomData {
		address payable customRecipient;
		uint256 customAmountIn;
		bytes customRoute;
		IUniswapV3Factory factory;
		INonfungiblePositionManager positionManager;
		IQuoterV2 quoter;
		uint256 minReturn;
		bool unwrapWethOut;
	}

	struct UniswapV3CustomDataOut {
		uint256 value;
		bytes data;
	}

	UniswapV3CustomData private args;

	// uint24 public fee = 500;

	// function setFee(uint24 _fee) external {
	// 	fee = _fee;
	// }

	/**
	 * @dev Decodes the encoded path string into tokens and fees.
	 * Assumes a pattern of address.fee.address.fee.address.
	 * @param encodedPath The encoded path string.
	 * @return tokens The decoded token addresses.
	 * @return fees The decoded fees.
	 */
	function decodePath(
		bytes memory encodedPath
	) public pure returns (address[] memory tokens, uint24[] memory fees) {
		// Calculate the count of tokens and fees based on the encoded path length
		// Each token address is 20 bytes, each fee is 3 bytes, and the pattern is address.fee repeating ending with an address
		uint256 tokensCount = (encodedPath.length + 3) / 23;
		uint256 feesCount = tokensCount - 1;

		tokens = new address[](tokensCount);
		fees = new uint24[](feesCount);

		uint256 index = 0; // Track the current byte index in encodedPath

		for (uint256 i = 0; i < feesCount; i++) {
			// Extract and store token address
			tokens[i] = bytesToAddress(encodedPath, index);
			index += 20;

			// Extract and store fee
			fees[i] = bytesToUint24(encodedPath, index);
			index += 3;
		}

		// Extract the last token address (no trailing fee)
		tokens[tokensCount - 1] = bytesToAddress(encodedPath, index);
	}

	/**
	 * @dev Converts a slice of bytes from a larger bytes array into an address.
	 * @param data The bytes array containing the address.
	 * @param start The start index of the address slice.
	 * @return addr The address converted from the bytes slice.
	 */
	function bytesToAddress(bytes memory data, uint256 start) private pure returns (address addr) {
		require(data.length >= start + 20, 'Data too short');
		assembly {
			addr := mload(add(data, add(0x14, start)))
		}
	}

	/**
	 * @dev Converts a slice of bytes from a larger bytes array into a uint24.
	 * @param data The bytes array containing the uint24.
	 * @param start The start index of the uint24 slice.
	 * @return value The uint24 converted from the bytes slice.
	 */
	function bytesToUint24(bytes memory data, uint256 start) private pure returns (uint24 value) {
		require(data.length >= start + 3, 'Data too short');
		assembly {
			value := mload(add(data, add(0x3, start)))
			// Mask to select only the last 3 bytes
			value := and(value, 0xFFFFFF)
		}
	}

	function toOneInchUniswapV3SwapTo(
		UniswapV3CustomData calldata inputArgs
	) external returns (UniswapV3CustomDataOut memory customTxData, uint256 minReturn) {
		args = inputArgs;
		minReturn = args.minReturn;

		require(args.customRoute.length >= 2, 'wrong route here');

		(address[] memory tokens, uint24[] memory fees) = decodePath(args.customRoute);

		if (tokens[0] == _NATIVE_ASSET) {
			customTxData.value = args.customAmountIn;
		}

		uint256 newRouteLength = fees.length;
		require(newRouteLength == tokens.length - 1, 'Invalid Route Length');

		uint256[] memory pools = new uint256[](newRouteLength);

		uint256 pool;
		for (uint256 i; i < newRouteLength; ++i) {
			(address token0, address token1, uint24 fee) = (tokens[i], tokens[i + 1], fees[i]);
			address poolV3 = token0 < token1
				? args.factory.getPool(token0, token1, fee)
				: args.factory.getPool(token1, token0, fee);

			pool = pool | uint160(poolV3);

			bool zeroForOne = IUniswapV3PoolTest(poolV3).token0() == token0;

			IQuoterV2.QuoteExactInputSingleParams memory params = IQuoterV2.QuoteExactInputSingleParams(
				token0,
				token1,
				minReturn,
				fee,
				_MIN_SQRT_RATIO
			);

			if (!zeroForOne) {
				pool = pool | _ONE_FOR_ZERO_MASK;
			}
			pools[i] = pool;
			delete pool;
		}

		customTxData.data = abi.encodeCall(
			IAggregationRouterV5.uniswapV3SwapTo,
			(args.customRecipient, args.customAmountIn, minReturn, pools)
		);
	}

	function toOneInchUniswapV3Swap(
		UniswapV3CustomData calldata inputArgs
	) external returns (UniswapV3CustomDataOut memory customTxData, uint256 minReturn) {
		args = inputArgs;

		require(args.customRoute.length >= 2, 'wrong route here');

		(address[] memory tokens, uint24[] memory fees) = decodePath(args.customRoute);

		if (tokens[0] == _NATIVE_ASSET) {
			customTxData.value = args.customAmountIn;
		}

		uint256 newRouteLength = fees.length;
		require(newRouteLength == tokens.length - 1, 'Invalid Route Length');

		uint256[] memory pools = new uint256[](newRouteLength);

		uint256 pool;
		for (uint256 i; i < newRouteLength; ++i) {
			(address token0, address token1, uint24 fee) = (tokens[i], tokens[i + 1], fees[i]);

			address poolV3 = args.factory.getPool(token0, token1, fee);

			pool = pool | uint160(poolV3);

			bool zeroForOne = IUniswapV3PoolTest(poolV3).token0() == token0;

			if (!zeroForOne) {
				pool = pool | _ONE_FOR_ZERO_MASK;
			}

			pools[i] = pool;
		}

		minReturn = args.minReturn;

		customTxData.data = abi.encodeCall(
			IAggregationRouterV5.uniswapV3Swap,
			(args.customAmountIn, minReturn, pools)
		);

		delete args;
	}

	function extractCalldata(
		bytes memory calldataWithSelector
	) internal pure returns (bytes memory calldataWithoutSelector) {
		assembly {
			let totalLength := mload(calldataWithSelector)
			let targetLength := sub(totalLength, 4)
			calldataWithoutSelector := mload(0x40)

			// Set the length of callDataWithoutSelector (initial length - 4)
			mstore(calldataWithoutSelector, targetLength)

			// Mark the memory space taken for callDataWithoutSelector as allocated
			mstore(0x40, add(calldataWithoutSelector, add(0x20, targetLength)))

			// Process first 32 bytes (we only take the last 28 bytes)
			mstore(add(calldataWithoutSelector, 0x20), shl(0x20, mload(add(calldataWithSelector, 0x20))))

			// Process all other data by chunks of 32 bytes
			for {
				let i := 0x1C
			} lt(i, targetLength) {
				i := add(i, 0x20)
			} {
				mstore(
					add(add(calldataWithoutSelector, 0x20), i),
					mload(add(add(calldataWithSelector, 0x20), add(i, 0x04)))
				)
			}
		}

		return calldataWithoutSelector;
	}

	// function _uniswapV3Swap(
	// 	address payable recipient,
	// 	uint256 amount,
	// 	uint256 minReturn,
	// 	uint256[] calldata pools
	// ) private returns (uint256 returnAmount) {
	// 	unchecked {
	// 		uint256 len = pools.length;
	// 		if (len == 0) revert EmptyPools();
	// 		uint256 lastIndex = len - 1;
	// 		returnAmount = amount;
	// 		bool wrapWeth = msg.value > 0;
	// 		bool unwrapWeth = pools[lastIndex] & _WETH_UNWRAP_MASK > 0;
	// 		if (wrapWeth) {
	// 			if (msg.value != amount) revert RouterErrors.InvalidMsgValue();
	// 			_WETH.deposit{value: amount}();
	// 		}
	// 		if (len > 1) {
	// 			returnAmount = _makeSwap(
	// 				address(this),
	// 				wrapWeth ? address(this) : msg.sender,
	// 				pools[0],
	// 				returnAmount
	// 			);

	// 			for (uint256 i = 1; i < lastIndex; i++) {
	// 				returnAmount = _makeSwap(address(this), address(this), pools[i], returnAmount);
	// 			}
	// 			returnAmount = _makeSwap(
	// 				unwrapWeth ? address(this) : recipient,
	// 				address(this),
	// 				pools[lastIndex],
	// 				returnAmount
	// 			);
	// 		} else {
	// 			returnAmount = _makeSwap(
	// 				unwrapWeth ? address(this) : recipient,
	// 				wrapWeth ? address(this) : msg.sender,
	// 				pools[0],
	// 				returnAmount
	// 			);
	// 		}

	// 		if (returnAmount < minReturn) revert RouterErrors.ReturnAmountIsNotEnough();

	// 		if (unwrapWeth) {
	// 			_WETH.withdraw(returnAmount);
	// 			recipient.sendValue(returnAmount);
	// 		}
	// 	}
	// }
}
