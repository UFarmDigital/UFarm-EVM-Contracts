// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

/// CONTRACTS
import {Controller} from './Controller.sol';
import {NZGuard} from '../../shared/NZGuard.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {UFarmErrors} from '../../shared/UFarmErrors.sol';

/// INTERFACES
import {IPriceOracle} from '../oracle/IPriceOracle.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {IUniswapV2Router02} from '../../../test/Uniswap/contracts/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol';
import {IUniswapV2Factory} from '../../../test/Uniswap/contracts/v2-core/contracts/interfaces/IUniswapV2Factory.sol';
import {IUniswapV2Pair} from '../../../test/Uniswap/contracts/v2-core/contracts/interfaces/IUniswapV2Pair.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {IPoolWhitelist} from '../pool/PoolWhitelist.sol';
import {IController, IERC20CommonController, IERC20SynthController} from './IController.sol';

/// LIBRARIES
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {UFarmMathLib} from '../../shared/UFarmMathLib.sol';

interface IUnoswapV2Controller is IERC20CommonController, IERC20SynthController {
	/**
	 * @notice Returns exact amount of tokens that will be spent to provide maximum lp tokens
	 * @param tokenA - address of the first token in the pair
	 * @param tokenB - address of the second token in the pair
	 * @param amountADesired - desired amount of tokenA to be provided
	 * @param amountBDesired - desired amount of tokenB to be provided
	 * @param amountAMin - minimum amount of tokenA to be spent
	 * @param amountBMin - minimum amount of tokenB to be spent
	 * @param deadline - deadline for the operation in UNIX time
	 * @return amountA - amount of tokenA to be spent
	 * @return amountB - amount of tokenB to be spent
	 * @return pair - address of the pair that was used for adding liquidity
	 */
	function quoteExactLiquidityAmounts(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		uint256 deadline
	) external view returns (uint256 amountA, uint256 amountB, address pair);

	function PROTOCOL() external view returns (bytes32);
}

/**
 * @title UnoswapV2Controller contract
 * @author https://ufarm.digital/
 * @notice Manages all swaps and liquidity operations for UniswapV2-like protocols
 */
abstract contract UnoswapV2Controller is
	IUnoswapV2Controller,
	Controller,
	NZGuard,
	UFarmErrors,
	ReentrancyGuard
{
	using SafeERC20 for IERC20;
	bytes32 public immutable FACTORY_INIT_CODE_HASH; // Needs to be hardcoded in the contract

	IUniswapV2Factory public immutable factory;
	IUniswapV2Router02 public immutable router;
	address public immutable priceOracle;

	/**
	 * @notice Emitted when swap is executed
	 * @param tokenIn - token to swap from
	 * @param tokenOut - token to swap to
	 * @param amountIn - amount of tokens to swap
	 * @param amountOut - minimum amount of tokens to receive
	 * @param protocol - protocol hashed name
	 */
	event SwapUnoV2(
		address indexed tokenIn,
		address indexed tokenOut,
		uint256 amountIn,
		uint256 amountOut,
		bytes32 protocol
	);

	/**
	 * @notice Emitted when liquidity is added to the pool
	 * @param tokenA - address of the first token spent for liquidity
	 * @param tokenB - address of the second token spent for liquidity
	 * @param amountA - amount of tokenA spent for liquidity
	 * @param amountB - amount of tokenB spent for liquidity
	 * @param liquidity - amount of liquidity tokens received
	 * @param pair - liquidity pair address
	 * @param protocol - protocol hashed name
	 */
	event LiquidityAddedUnoV2(
		address indexed tokenA,
		address indexed tokenB,
		uint256 amountA,
		uint256 amountB,
		uint256 liquidity,
		address indexed pair,
		bytes32 protocol
	);

	/**
	 * @notice Emitted when liquidity is removed from the pool
	 * @param tokenA - address of the first token received for liquidity
	 * @param tokenB - address of the second token received for liquidity
	 * @param amountA - amount of tokenA received for liquidity
	 * @param amountB - amount of tokenB received for liquidity
	 * @param liquidity - amount of liquidity tokens spent
	 * @param pair - liquidity pair address
	 * @param target - address of the target for the removed liquidity
	 * @param protocol - protocol hashed name
	 */
	event LiquidityRemovedUnoV2(
		address indexed tokenA,
		address indexed tokenB,
		uint256 amountA,
		uint256 amountB,
		uint256 liquidity,
		address indexed pair,
		address target,
		bytes32 protocol
	);

	error INSUFFICIENT_A_AMOUNT();
	error INSUFFICIENT_B_AMOUNT();
	error DEADLINE_PASSED();
	error IDENTICAL_ADDRESSES();
	error INSUFFICIENT_AMOUNT();
	error INSUFFICIENT_LIQUIDITY();
	error INSUFFICIENT_INPUT_AMOUNT();
	error INSUFFICIENT_OUTPUT_AMOUNT();
	error INVALID_PATH();
	error INVALID_PAIR();

	/**
	 * @notice UnoswapV2Controller constructor
	 * @param _factory - address of the UnoswapV2 factory
	 * @param _router - address of the UnoswapV2 router
	 * @param _priceOracle - address of the PriceOracle
	 * @param _factoryInitCodeHash - init code hash of the UnoswapV2 factory
	 */
	constructor(
		address _factory,
		address _router,
		address _priceOracle,
		bytes32 _factoryInitCodeHash
	)
		nonZeroAddress(_factory)
		nonZeroAddress(_router)
		nonZeroAddress(_priceOracle)
		nonZeroBytes32(_factoryInitCodeHash)
	{
		factory = IUniswapV2Factory(_factory);
		router = IUniswapV2Router02(_router);
		priceOracle = _priceOracle;
		FACTORY_INIT_CODE_HASH = _factoryInitCodeHash;
	}

	/**
	 * @inheritdoc IController
	 */
	function PROTOCOL()
		public
		pure
		virtual
		override(Controller, IUnoswapV2Controller)
		returns (bytes32);

	/**
	 * @notice Returns amount of tokens that will be received for given amountIn and path
	 * @param amountIn - amount of tokens to swap
	 * @param path - path of tokens to swap
	 */
	function getAmountOut(uint256 amountIn, address[] memory path) public view returns (uint256) {
		if (path.length < 2) revert INVALID_PATH();

		// Using router:
		uint256[] memory amounts = router.getAmountsOut(amountIn, path);
		return amounts[path.length - 1];
	}

	/**
	 * @notice Returns amount of tokens that will be spent for given amountOut and path
	 * @param amountOut - amount of tokens to receive
	 * @param path - path of tokens to swap
	 */
	function getAmountIn(uint256 amountOut, address[] memory path) public view returns (uint256) {
		if (path.length < 2) revert INVALID_PATH();

		// Using router:
		uint256[] memory amounts = router.getAmountsIn(amountOut, path);
		return amounts[0];
	}

	struct UniV2SwapExactTokensForTokensArgs {
		uint256 amountIn;
		uint256 amountOutMin;
		uint256 deadline;
	}

	/**
	 * @notice Swaps pool assets via delegate call using UniswapV2-like protocol
	 * @param _data - encoded data for protocol controller
	 */
	function delegateSwapExactTokensForTokens(
		bytes calldata _data
	) external checkDelegateCall nonReentrant {
		// (address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
		(UniV2SwapExactTokensForTokensArgs memory swArgs, address[] memory path) = abi.decode(
			_data,
			(UniV2SwapExactTokensForTokensArgs, address[])
		);

		_checkDeadline(swArgs.deadline);

		// UnoswapV2Controller thisController = _delegatedThisController();

		(uint256 pathLength, uint256 amountIn) = (path.length, swArgs.amountIn);

		if (pathLength < 2) revert INVALID_PATH();

		// FIRST SWAP
		(address tokenIn, address tokenOut) = (path[0], path[1]);

		IPoolWhitelist pool = IPoolWhitelist(address(this));

		if (!pool.isTokenAllowed(tokenOut)) revert IPoolWhitelist.TokenIsNotAllowed(tokenOut);

		bool reversed = tokenIn > tokenOut;

		(address tokenA, address tokenB) = (
			reversed ? tokenOut : tokenIn,
			reversed ? tokenIn : tokenOut
		);

		IUniswapV2Pair pair = IUniswapV2Pair(pairFor(tokenA, tokenB));

		IERC20(tokenIn).safeTransfer(address(pair), amountIn);

		address swapTarget = pathLength > 2 ? pairFor(tokenOut, path[2]) : address(this);

		(uint112 reserve0, uint112 reserve1, ) = pair.getReserves();

		uint256 amountOut = getAmountOutReserves(
			amountIn,
			reversed ? reserve1 : reserve0,
			reversed ? reserve0 : reserve1
		);

		_checkOutAmount(amountOut, 1);

		pair.swap(reversed ? amountOut : 0, reversed ? 0 : amountOut, swapTarget, new bytes(0));
		// next swap if pathLength > 2
		for (uint256 i; i < pathLength - 2; ++i) {
			(tokenIn, tokenOut) = (path[i + 1], path[i + 2]);

			if (!pool.isTokenAllowed(tokenOut)) revert IPoolWhitelist.TokenIsNotAllowed(tokenOut);

			reversed = tokenIn > tokenOut;
			(tokenA, tokenB) = (reversed ? tokenOut : tokenIn, reversed ? tokenIn : tokenOut);

			// pair addres was destination of previous swap
			pair = IUniswapV2Pair(swapTarget);

			// if there is next swap, then transfer destionation is the next pair
			swapTarget = i < pathLength - 3 ? pairFor(tokenOut, path[i + 3]) : address(this);

			(reserve0, reserve1, ) = pair.getReserves();

			amountOut = getAmountOutReserves(
				amountOut,
				reversed ? reserve1 : reserve0,
				reversed ? reserve0 : reserve1
			);

			_checkOutAmount(amountOut, 1);

			pair.swap(reversed ? amountOut : 0, reversed ? 0 : amountOut, swapTarget, new bytes(0));
		}

		_checkOutAmount(amountOut, swArgs.amountOutMin);

		tokenIn = path[0];

		IUFarmPool(address(this)).removeERC20(tokenIn);
		IUFarmPool(address(this)).addERC20(tokenOut, bytes32(0));

		emit SwapUnoV2(tokenIn, tokenOut, amountIn, amountOut, PROTOCOL());
	}

	struct UniV2AddLiquidityArgs {
		address tokenA;
		address tokenB;
		uint256 amountADesired;
		uint256 amountBDesired;
		uint256 amountAMin;
		uint256 amountBMin;
		uint256 deadline;
	}

	/**
	 * @notice Adds liquidity to the pool via delegate call using UniswapV2-like protocol
	 * @param _data - encoded data for protocol controller
	 */
	function delegatedAddLiquidity(bytes calldata _data) external checkDelegateCall nonReentrant {
		UniV2AddLiquidityArgs memory alArgs = abi.decode(_data, (UniV2AddLiquidityArgs));

		_checkDeadline(alArgs.deadline);

		(address tokenA, address tokenB) = (alArgs.tokenA, alArgs.tokenB);

		IPoolWhitelist pool = IPoolWhitelist(address(this));

		if (!pool.isTokenAllowed(tokenA)) revert IPoolWhitelist.TokenIsNotAllowed(tokenA);
		if (!pool.isTokenAllowed(tokenB)) revert IPoolWhitelist.TokenIsNotAllowed(tokenB);

		UnoswapV2Controller thisController = _delegatedThisController();
		(uint256 amountA, uint256 amountB, address pair) = thisController.quoteExactLiquidityAmounts(
			tokenA,
			tokenB,
			alArgs.amountADesired,
			alArgs.amountBDesired,
			alArgs.amountAMin,
			alArgs.amountBMin,
			alArgs.deadline
		);

		bool reversed = tokenA > tokenB;

		IERC20(tokenA).safeTransfer(pair, reversed ? amountB : amountA);
		IERC20(tokenB).safeTransfer(pair, reversed ? amountA : amountB);

		// pair should check for 0 liquidity
		uint256 liquidity = IUniswapV2Pair(pair).mint(address(this));

		if (liquidity == 0) revert INSUFFICIENT_LIQUIDITY();

		IUFarmPool(address(this)).removeERC20(tokenA);
		IUFarmPool(address(this)).removeERC20(tokenB);
		IUFarmPool(address(this)).addERC20(pair, PROTOCOL());

		emit LiquidityAddedUnoV2(tokenA, tokenB, amountA, amountB, liquidity, pair, PROTOCOL());
	}

	struct UniV2RemoveLiquidityArgs {
		address tokenA;
		address tokenB;
		uint256 liquidity;
		uint256 amountAMin;
		uint256 amountBMin;
		uint256 deadline;
	}

	/**
	 * @notice Removes liquidity from the pool via delegate call using UniswapV2-like protocol
	 * @param _data - encoded data for protocol controller
	 */
	function delegatedRemoveLiquidity(bytes calldata _data) external checkDelegateCall nonReentrant {
		UniV2RemoveLiquidityArgs memory rlArgs = abi.decode(_data, (UniV2RemoveLiquidityArgs));
		_checkDeadline(rlArgs.deadline);

		(address tokenA, address tokenB) = (rlArgs.tokenA, rlArgs.tokenB);

		if (tokenA > tokenB) {
			(tokenA, tokenB) = (tokenB, tokenA);
			(rlArgs.amountAMin, rlArgs.amountBMin) = (rlArgs.amountBMin, rlArgs.amountAMin);
		}

		address pair = pairForSorted(tokenA, tokenB);
		IERC20(pair).safeTransfer(pair, rlArgs.liquidity);

		IUFarmPool pool = IUFarmPool(address(this));
		(address _target, bytes32 _withdrawalHash) = _getTarget();

		(uint256 amountA, uint256 amountB) = IUniswapV2Pair(pair).burn(_target);

		if (amountA < rlArgs.amountAMin) revert INSUFFICIENT_A_AMOUNT();
		if (amountB < rlArgs.amountBMin) revert INSUFFICIENT_B_AMOUNT();

		pool.removeERC20(pair);

		if (_target == address(this)) {
			pool.addERC20(tokenA, bytes32(0));
			pool.addERC20(tokenB, bytes32(0));
		} else {
			emit IUFarmPool.Withdraw(_target, tokenA, amountA, _withdrawalHash);
			emit IUFarmPool.Withdraw(_target, tokenB, amountB, _withdrawalHash);
		}

		emit LiquidityRemovedUnoV2(
			tokenA,
			tokenB,
			amountA,
			amountB,
			rlArgs.liquidity,
			pair,
			_target,
			PROTOCOL()
		);
	}

	/**
	 * @inheritdoc IERC20SynthController
	 */
	function encodePartialWithdrawalERC20(
		address _token,
		uint256 _numerator,
		uint256 _denominator
	) external view override returns (bytes[] memory encodedTxs) {
		encodedTxs = new bytes[](1);
		IUniswapV2Pair pair = IUniswapV2Pair(_token);
		(address token0, address token1) = (pair.token0(), pair.token1());

		uint256 liquidity = pair.balanceOf(msg.sender);
		uint256 amountToRemove = (liquidity * _numerator) / _denominator;

		UniV2RemoveLiquidityArgs memory rlArgs = UniV2RemoveLiquidityArgs({
			tokenA: token0,
			tokenB: token1,
			liquidity: amountToRemove,
			amountAMin: 0,
			amountBMin: 0,
			deadline: block.timestamp
		});

		encodedTxs[0] = abi.encodeCall(
			UnoswapV2Controller.delegatedRemoveLiquidity,
			abi.encode(rlArgs)
		);
	}

	/**
	 * @notice Returns optimal amount of tokens that will be provided for given amountIn and path
	 * @param tokenA - address of the first token in the pair
	 * @param tokenB - address of the second token in the pair
	 * @param amountADesired - desired amount of tokenA to be provided
	 * @return amountB - optimal amount of tokenA that will be provided
	 * @return desiredLiquidity - amount of liquidity tokens that will be received
	 * @return totalLiquidity - total amount of liquidity tokens in the pair
	 * @return pair - address of the pair that was used for adding liquidity
	 */
	function quoteOptimalLiquidityAmount(
		address tokenA,
		address tokenB,
		uint256 amountADesired
	)
		external
		view
		nonZeroAddress(tokenA)
		nonZeroAddress(tokenB)
		returns (uint256 amountB, uint256 desiredLiquidity, uint256 totalLiquidity, address pair)
	{
		if (amountADesired == 0) {
			revert INSUFFICIENT_AMOUNT();
		}

		bool reversed = tokenA > tokenB;

		pair = pairFor(tokenA, tokenB);

		try IUniswapV2Pair(pair).getReserves() returns (uint112 reserveA, uint112 reserveB, uint32) {
			if (reserveA == 0 || reserveB == 0) {
				revert INSUFFICIENT_LIQUIDITY();
			}

			amountB = _quote(
				amountADesired,
				reversed ? reserveB : reserveA,
				reversed ? reserveA : reserveB
			);

			desiredLiquidity = UFarmMathLib.sqrt(amountADesired * amountB);
			totalLiquidity = IUniswapV2Pair(pair).totalSupply() + desiredLiquidity;
		} catch {
			revert INVALID_PAIR();
		}
	}

	/**
	 * @inheritdoc IUnoswapV2Controller
	 */
	function quoteExactLiquidityAmounts(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		uint256 deadline
	) external view override returns (uint256 amountA, uint256 amountB, address pair) {
		return
			_quoteExactLiquidityAmounts(
				tokenA,
				tokenB,
				amountADesired,
				amountBDesired,
				amountAMin,
				amountBMin,
				deadline
			);
	}

	/**
	 * @notice Returns token addresses and amounts that will be received for given lp token amount
	 * @param lpToken - address of the liquidity pool token
	 * @param balance - amount of lp tokens
	 * @return tokenA - address of the first token in the pair
	 * @return tokenB - address of the second token in the pair
	 * @return amountA - amount of tokenA to be received
	 * @return amountB - amount of tokenB to be received
	 * @return totalLiquidity - total amount of liquidity tokens in the pair
	 */
	function quoteExactTokenAmounts(
		address lpToken,
		uint256 balance
	)
		external
		view
		returns (
			address tokenA,
			address tokenB,
			uint256 amountA,
			uint256 amountB,
			uint256 totalLiquidity
		)
	{
		IUniswapV2Pair _pair = IUniswapV2Pair(lpToken);
		try _pair.getReserves() returns (uint112 reserveA, uint112 reserveB, uint32) {
			(tokenA, tokenB) = (_pair.token0(), _pair.token1());
			uint256 klast;
			(totalLiquidity, klast) = (_pair.totalSupply(), _pair.kLast());

			(amountA, amountB) = computeLiquidityValueWithFee(
				reserveA,
				reserveB,
				totalLiquidity,
				balance,
				true,
				klast
			);
		} catch {
			revert INVALID_PAIR();
		}
	}

	/**
	 * @inheritdoc IERC20SynthController
	 * @dev Thanks for the idea to Alpha Homora V2 team
	 * https://github.com/AlphaFinanceLab/alpha-homora-v2-contract/blob/f74fc460bd614ad15bbef57c88f6b470e5efd1fd/contracts/oracle/UniswapV2Oracle.sol#L20
	 */
	function getCostControlledERC20(
		address lpAsset,
		uint256 lpAmount,
		address valueToken
	) external view returns (uint256 cost) {
		IUniswapV2Pair pair = IUniswapV2Pair(lpAsset);
		uint256 totalSupply = pair.totalSupply();
		(address token0, address token1) = (pair.token0(), pair.token1());
		(uint256 reserve0, uint256 reserve1, ) = pair.getReserves();

		(uint256 fairPrice, uint8 numenator0, uint8 numenator1) = _getFairPrice(
			token0,
			token1,
			valueToken
		);
		uint256 sqrtK = UFarmMathLib.sqrt(reserve0) * UFarmMathLib.sqrt(reserve1);
		// Calculate price
		cost = (2 * sqrtK * fairPrice) / totalSupply;
		// Calculate cost in USD
		cost = (lpAmount * cost) / UFarmMathLib.sqrt(10 ** (numenator0 + numenator1));
		return cost;
	}

	function computeLiquidityValueWithFee(
		uint112 reservesA,
		uint112 reservesB,
		uint256 totalSupply,
		uint256 liquidityAmount,
		bool feeOn,
		uint256 kLast
	) internal pure returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		if (feeOn && kLast > 0) {
			uint256 rootK = UFarmMathLib.sqrt(reservesA * (reservesB));
			uint256 rootKLast = UFarmMathLib.sqrt(kLast);
			if (rootK > rootKLast) {
				uint numerator1 = totalSupply;
				uint numerator2 = rootK - rootKLast;
				uint denominator = rootK * (5) + (rootKLast);
				uint feeLiquidity = (numerator1 * numerator2) / denominator;
				totalSupply = totalSupply + feeLiquidity;
			}
		}
		return (
			(reservesA * (liquidityAmount)) / totalSupply,
			(reservesB * (liquidityAmount)) / totalSupply
		);
	}

	function _quoteExactLiquidityAmounts(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		uint256 deadline
	) internal view returns (uint256 amountA, uint256 amountB, address pair) {
		if (block.timestamp > deadline) revert DEADLINE_PASSED();
		if (amountADesired == 0 || amountBDesired == 0) {
			revert INSUFFICIENT_AMOUNT();
		}

		if (tokenA > tokenB) {
			(tokenA, tokenB) = (tokenB, tokenA);
			(amountADesired, amountBDesired) = (amountBDesired, amountADesired);
			(amountAMin, amountBMin) = (amountBMin, amountAMin);
		}

		pair = pairForSorted(tokenA, tokenB);

		try IUniswapV2Pair(pair).getReserves() returns (uint112 reserveA, uint112 reserveB, uint32) {
			if (reserveA == 0 || reserveB == 0) {
				revert INSUFFICIENT_LIQUIDITY();
			}

			uint256 amountBOptimal = _quote(amountADesired, reserveA, reserveB);

			if (amountBOptimal <= amountBDesired) {
				if (amountBOptimal < amountBMin) revert INSUFFICIENT_B_AMOUNT();
				return (amountADesired, amountBOptimal, pair);
			} else {
				uint256 amountAOptimal = _quote(amountBDesired, reserveB, reserveA);

				if (amountAOptimal < amountAMin || amountAOptimal > amountADesired)
					revert INSUFFICIENT_A_AMOUNT();

				return (amountAOptimal, amountBDesired, pair);
			}
		} catch {
			revert INVALID_PAIR();
		}
	}

	function _getFairPrice(
		address tokenA,
		address tokenB,
		address valueToken
	) internal view returns (uint256 fairPrice, uint8 decimals0, uint8 decimals1) {
		(decimals0, decimals1) = (IERC20Metadata(tokenA).decimals(), IERC20Metadata(tokenB).decimals());

		(uint256 fairPrice0, uint256 fairPrice1) = (
			IPriceOracle(priceOracle).getCostERC20(tokenA, 10 ** (decimals0), valueToken),
			IPriceOracle(priceOracle).getCostERC20(tokenB, 10 ** (decimals1), valueToken)
		);

		fairPrice = UFarmMathLib.sqrt(fairPrice0 * fairPrice1);
	}

	//  LIB

	function sortTokens(
		address tokenA,
		address tokenB
	) internal pure returns (address token0, address token1) {
		if (tokenA == tokenB) revert IDENTICAL_ADDRESSES();
		if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
		if (tokenA < tokenB) return (tokenA, tokenB);
		else return (tokenB, tokenA);
	}

	/**
	 * @notice Returns address of the pair for given tokens
	 * @dev Checks for address(0) and identical tokens addresses
	 * @param tokenA - address of the first token
	 * @param tokenB - address of the second token
	 * @return pair - address of the pair
	 */
	function pairFor(address tokenA, address tokenB) public view returns (address pair) {
		(address token0, address token1) = sortTokens(tokenA, tokenB);
		return pairForSorted(token0, token1);
	}

	/**
	 * @notice Returns address of the pair for given tokens
	 * @dev Doesn't check for address(0) and identical tokens addresses
	 * @param tokenA - address of the first token
	 * @param tokenB - address of the second token
	 * @return pair - address of the pair
	 */
	function pairForSorted(address tokenA, address tokenB) public view returns (address pair) {
		pair = address(
			uint160(
				uint256(
					keccak256(
						abi.encodePacked(
							hex'ff',
							factory,
							keccak256(abi.encodePacked(tokenA, tokenB)),
							FACTORY_INIT_CODE_HASH
						)
					)
				)
			)
		);
	}

	function _checkOutAmount(uint256 amountOut, uint256 amountOutMin) internal pure {
		if (amountOut < amountOutMin) revert INSUFFICIENT_OUTPUT_AMOUNT();
	}

	// fetches and sorts the reserves for a pair
	function _getReserves(
		address tokenA,
		address tokenB
	) private view returns (uint256 reserveA, uint256 reserveB) {
		(address token0, ) = sortTokens(tokenA, tokenB);
		(uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pairForSorted(tokenA, tokenB))
			.getReserves();
		(reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
	}

	// given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
	function _quote(
		uint256 amountA,
		uint256 reserveA,
		uint256 reserveB
	) private pure returns (uint256 amountB) {
		amountB = (amountA * (reserveB)) / reserveA;
	}

	// given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
	function getAmountOutReserves(
		uint256 amountIn,
		uint256 reserveIn,
		uint256 reserveOut
	) private pure returns (uint256 amountOut) {
		if (amountIn == 0) revert INSUFFICIENT_INPUT_AMOUNT();
		if (reserveIn == 0 || reserveOut == 0) revert INSUFFICIENT_LIQUIDITY();
		uint256 amountInWithFee = amountIn * (997);
		uint256 numerator = amountInWithFee * (reserveOut);
		uint256 denominator = reserveIn * (1000) + (amountInWithFee);
		amountOut = numerator / denominator;
	}

	// given an output amount of an asset and pair reserves, returns a required input amount of the other asset
	function getAmountInRes(
		uint256 amountOut,
		uint256 reserveIn,
		uint256 reserveOut
	) private pure returns (uint256 amountIn) {
		if (amountOut == 0) revert INSUFFICIENT_OUTPUT_AMOUNT();
		if (reserveIn == 0 || reserveOut == 0) revert INSUFFICIENT_LIQUIDITY();
		uint256 numerator = reserveIn * (amountOut) * (1000);
		uint256 denominator = (reserveOut - amountOut) * (997);
		amountIn = (numerator / denominator) + (1);
	}

	// performs chained getAmountOut calculations on any number of pairs
	function getAmountsOut(
		uint256 amountIn,
		address[] memory path
	) private view returns (uint256[] memory amounts) {
		uint256 length = path.length;
		if (length < 2) revert INVALID_PATH();
		amounts = new uint256[](length);
		amounts[0] = amountIn;
		for (uint256 i; i < length - 1; ++i) {
			(uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i], path[i + 1]);
			amounts[i + 1] = getAmountOutReserves(amounts[i], reserveIn, reserveOut);
		}
	}

	function _checkDeadline(uint256 deadline) private view {
		if (block.timestamp > deadline) revert DEADLINE_PASSED();
	}

	function _delegatedThisController() private view returns (UnoswapV2Controller controller) {
		IUFarmPool pool = IUFarmPool(address(this));
		controller = UnoswapV2Controller(payable(IUFarmCore(pool.ufarmCore()).controllers(PROTOCOL())));
		if (address(controller) == address(0)) revert FETCHING_CONTROLLER_FAILED();
	}
}
