// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.24;

/// CONTRACTS
import {UFarmErrors} from "../../shared/UFarmErrors.sol";
import {NZGuard} from "../../shared/NZGuard.sol";
import {Controller, IController} from "./Controller.sol";
import {SafeOPS} from "../../shared/SafeOPS.sol";

/// INTERFACES
import {IUFarmPool} from "../pool/IUFarmPool.sol";
import {IUFarmCore} from "../core/IUFarmCore.sol";
import {IERC20} from "../../../test/Uniswap/contracts/v2-core/contracts/interfaces/IERC20.sol";
import {IPoolWhitelist} from "../pool/PoolWhitelist.sol";
import {IERC721Controller} from "./IController.sol";
import {ISwapRouter} from "../../../test/UniswapV3/@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IUniswapV3Pool} from "../../../test/UniswapV3/@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// LIBRARIES
import {TickMath} from "../../../test/UniswapV3/@uniswap/v3-core/contracts/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../../test/UniswapV3/@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import {FixedPoint96} from "../../../test/UniswapV3/@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import {FixedPoint128} from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import {PositionValue, INonfungiblePositionManager} from "../../../test/UniswapV3/@uniswap/v3-periphery/contracts/libraries/PositionValue.sol";

interface IUnoswapV3Controller is IERC721Controller {
    function delegatedSwapExactInputSingleHop(bytes calldata _data) external;
}

/**
 * @title UnoswapV3Controller contract
 * @author https://ufarm.digital/
 * @notice Controller contract for UniswapV3-like protocols
 */
abstract contract UnoswapV3Controller is IUnoswapV3Controller, Controller, NZGuard, UFarmErrors, ReentrancyGuard {
    using PositionValue for INonfungiblePositionManager;

    struct PoolKey {
        address token0;
        address token1;
        uint24 fee;
    }

    struct FeeParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 positionFeeGrowthInside0LastX128;
        uint256 positionFeeGrowthInside1LastX128;
        uint256 tokensOwed0;
        uint256 tokensOwed1;
    }

    struct UniV3Pos {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    bytes32 public immutable POOL_INIT_CODE_HASH;
    address public immutable swapRouter;
    address public immutable swapFactory;
    address public immutable priceOracle;
    INonfungiblePositionManager public immutable nfpm;

    /**
     * @notice Emitted when a new position is minted.
     * @param token0 - spent token0 address
     * @param token1 - spent token1 address
     * @param tokenAddr - recieved position token address
     * @param fee - position fee
     * @param tickLower - position lower tick
     * @param tickUpper - position upper tick
     * @param liquidityMinted - liquidity minted
     * @param tokenId - position token id recieved
     * @param amount0 - amount of token0 spent
     * @param amount1 - amount of token1 spent
     * @param protocol - protocol hashed name
     */
    event PositionMintedUnoV3(
        address indexed token0,
        address indexed token1,
        address indexed tokenAddr,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidityMinted,
        uint256 tokenId,
        uint256 amount0,
        uint256 amount1,
        bytes32 protocol
    );

    /**
     * @notice Emitted when a position is burned.
     * @param tokenAddr - position token address burned
     * @param tokenId - position token id burned
     * @param protocol - protocol hashed name
     */
    event PositionBurnedUnoV3(address indexed tokenAddr, uint256 tokenId, bytes32 protocol);

    /**
     * @notice Emitted when liquidity is increased for a position NFT.
     * @param token0 - token0 spent address
     * @param token1 - token1 spent address
     * @param tokenAddr - position token address
     * @param tokenId - position token id
     * @param liquidityIncreased - liquidity increased to
     * @param amount0Increased - amount of token0 increased to
     * @param amount1Increased - amount of token1 increased to
     * @param protocol - protocol hashed name
     */
    event PositionIncreasedUnoV3(
        address indexed token0,
        address indexed token1,
        address indexed tokenAddr,
        uint256 tokenId,
        uint128 liquidityIncreased,
        uint256 amount0Increased,
        uint256 amount1Increased,
        bytes32 protocol
    );

    /**
     * @notice Emitted when liquidity is decreased for a position NFT.
     * @dev Does not transfer any tokens, tokens must be collected separately.
     * @param token0 - token0 decreased address
     * @param token1 - token1 decreased address
     * @param tokenAddr - position token address
     * @param tokenId - position token id
     * @param liquidityDecreased - liquidity decreased by
     * @param amount0Decreased - amount of token0 decreased by
     * @param amount1Decreased - amount of token1 decreased by
     * @param protocol - protocol hashed name
     */
    event PositionDecreasedUnoV3(
        address indexed token0,
        address indexed token1,
        address indexed tokenAddr,
        uint256 tokenId,
        uint128 liquidityDecreased,
        uint256 amount0Decreased,
        uint256 amount1Decreased,
        bytes32 protocol
    );

    /**
     * @notice Emitted when tokens been swapped.
     * @param tokenIn - spent token address
     * @param tokenOut - recieved token address
     * @param amountIn - amount of tokenIn spent
     * @param amountOut - amount of tokenOut recieved
     * @param protocol - protocol hashed name
     */
    event SwapUnoV3(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 protocol
    );

    /**
     * @notice Emitted when fees been collected.
     * @param tokenAddr - position token address
     * @param token0 - collected token0 address
     * @param token1 - collected token1 address
     * @param target - recipient address, may be user or pool
     * @param tokenId - position token id
     * @param amount0 - amount of token0 collected
     * @param amount1 - amount of token1 collected
     * @param protocol - protocol hashed name
     */
    event FeesCollectedUnoV3(
        address indexed tokenAddr,
        address indexed token0,
        address indexed token1,
        address target,
        uint256 tokenId,
        uint256 amount0,
        uint256 amount1,
        bytes32 protocol
    );

    error INVALID_RECIPIENT();
    error INVALID_POSITION_OWNER();
    error POSITION_NOT_FOUND();
    error DEADLINE_PASSED();

    /**
     * @notice UnoswapV3Controller constructor
     * @param _swapRouter - address of the Uniswap SwapRouter
     * @param _swapFactory - address of the UniswapV3 factory
     * @param _nfpm - address of the UniswapV3 NonfungiblePositionManager
     * @param _priceOracle - address of the PriceOracle
     * @param _univ3InitCodeHash - init code hash of the UniswapV3 factory
     */
    constructor(
        address _swapRouter,
        address _swapFactory,
        address _nfpm,
        address _priceOracle,
        bytes32 _univ3InitCodeHash
    ) nonZeroAddress(_swapRouter) nonZeroAddress(_swapFactory) nonZeroAddress(_nfpm) nonZeroAddress(_priceOracle) {
        swapRouter = _swapRouter;
        swapFactory = _swapFactory;
        priceOracle = _priceOracle;
        nfpm = INonfungiblePositionManager(_nfpm);
        POOL_INIT_CODE_HASH = _univ3InitCodeHash;
    }

    /**
     * @dev Hardcoded TWAP period
     */
    function TWAP_PERIOD() public pure virtual returns (uint32);

    /**
     * @notice Returns TWAP price for the specified period on the specified pool
     *
     * @param _period - TWAP period
     * @param _pool - pool address
     * @return sqrtPriceX96 - TWAP price
     */
    function getTWAPsqrt(uint32 _period, address _pool) public view returns (uint160 sqrtPriceX96) {
        require(_period > 0, "Period must be greater than 0");

        uint32 period = _period;
        uint32[] memory secondsAgos = new uint32[](2);
        // Current timestamp
        secondsAgos[1] = 0;

        while (period > 0) {
            // Start of the period
            secondsAgos[0] = _period;

            try IUniswapV3Pool(_pool).observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
                // Calculate the average tick for the specified period
                int56 tickDifference = tickCumulatives[1] - tickCumulatives[0];
                int24 averageTick = int24(tickDifference / int56(int32(_period)));
                sqrtPriceX96 = TickMath.getSqrtRatioAtTick(averageTick);
                return sqrtPriceX96;
            } catch {
                // Halve the period if the attempt fails
                period /= 2;
            }
        }

        // If all attempts fail, fallback to the current price from slot0
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(_pool).slot0();
    }

    /**
     * @notice Executes SwapExactInputSingle on Uniswap V3
     * @param _data - encoded SwapExactInputSingleParams struct
     */
    function delegatedSwapExactInputSingleHop(bytes calldata _data) external checkDelegateCall nonReentrant {
        ISwapRouter.ExactInputSingleParams memory params = abi.decode(_data, (ISwapRouter.ExactInputSingleParams));

        if (params.recipient != address(this)) revert INVALID_RECIPIENT();

        (address tokenIn, address tokenOut) = (params.tokenIn, params.tokenOut);
        uint256 amountIn = params.amountIn;

        if (!IPoolWhitelist(address(this)).isTokenAllowed(tokenOut)) revert IPoolWhitelist.TokenIsNotAllowed(tokenOut);

        SafeOPS._forceApprove(tokenIn, swapRouter, amountIn);

        uint256 amountOut = ISwapRouter(swapRouter).exactInputSingle(params);

        emit SwapUnoV3(tokenIn, tokenOut, amountIn, amountOut, PROTOCOL());
    }

    /**
     * @notice Executes SwapExactInput on Uniswap V3
     * @param _data - encoded SwapExactInputParams struct
     */
    function delegatedSwapExactInputMultiHop(bytes calldata _data) external checkDelegateCall nonReentrant {
        // Solidity can't decode dynamic arrays from structs, so we have to do it manually
        (address _recipient, uint256 _deadline, uint256 amountIn, uint256 amountOut, bytes memory _path) = abi.decode(
            _data,
            (address, uint256, uint256, uint256, bytes)
        );

        IPoolWhitelist pool = IPoolWhitelist(address(this));

        address tokenIn;
        address tokenOut;

        assembly {
            tokenIn := mload(add(_path, 20)) // gets first token (0x14 == 20 bytes == address size)
        }

        uint256 pathLength = _path.length;

        // Start with the second token in the path
        for (uint256 i = 43; i <= pathLength; i += 23) {
            assembly {
                // Calculate the memory pointer by adding the offset to the start of the _path data
                let ptr := add(_path, i)

                // Load the value from the calculated memory pointer into tokenOut
                tokenOut := mload(ptr)
            }

            if (!pool.isTokenAllowed(tokenOut)) revert IPoolWhitelist.TokenIsNotAllowed(tokenOut);
        }

        // prepare arguments
        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: _path,
            recipient: address(this),
            deadline: _deadline,
            amountIn: amountIn,
            amountOutMinimum: amountOut
        });

        // swap with multihop
        SafeOPS._forceApprove(tokenIn, swapRouter, amountIn);
        amountOut = ISwapRouter(swapRouter).exactInput(params);

        emit SwapUnoV3(tokenIn, tokenOut, amountIn, amountOut, PROTOCOL());
    }

    /**
     * @notice Executes minting of a new position on Uniswap V3
     * @param _data - encoded MintParams struct
     */
    function delegateMintNewPosition(bytes calldata _data) external checkDelegateCall nonReentrant {
        INonfungiblePositionManager.MintParams memory mintParams = abi.decode(
            _data,
            (INonfungiblePositionManager.MintParams)
        );

        (address token0, address token1) = (mintParams.token0, mintParams.token1);

        if (!IPoolWhitelist(address(this)).isTokenAllowed(token0)) revert IPoolWhitelist.TokenIsNotAllowed(token0);
        if (!IPoolWhitelist(address(this)).isTokenAllowed(token1)) revert IPoolWhitelist.TokenIsNotAllowed(token1);

        if (token0 > token1) {
            (token0, token1) = (token1, token0);

            (mintParams.token0, mintParams.token1) = (mintParams.token1, mintParams.token0);

            (mintParams.amount0Desired, mintParams.amount1Desired, mintParams.amount0Min, mintParams.amount1Min) = (
                mintParams.amount1Desired,
                mintParams.amount0Desired,
                mintParams.amount1Min,
                mintParams.amount0Min
            );
        }

        if (mintParams.recipient != address(this)) mintParams.recipient = address(this);

        address _nfpm = address(nfpm);

        SafeOPS._forceApprove(token0, _nfpm, mintParams.amount0Desired);
        SafeOPS._forceApprove(token1, _nfpm, mintParams.amount1Desired);

        (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) = nfpm.mint(mintParams);

        if (amount0 > 0) {
            if (amount0 < mintParams.amount0Desired) {
                IERC20(token0).approve(_nfpm, 0);
            }
        }
        if (amount1 > 0) {
            if (amount1 < mintParams.amount1Desired) {
                IERC20(token1).approve(_nfpm, 0);
            }
        }

        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;

        emit PositionMintedUnoV3(
            token0,
            token1,
            _nfpm,
            mintParams.fee,
            mintParams.tickLower,
            mintParams.tickUpper,
            liquidity,
            tokenId,
            amount0,
            amount1,
            PROTOCOL()
        );
    }

    /**
     * @notice Executes burning of a position on Uniswap V3
     * @param _data - encoded BurnParams struct
     */
    function delegateBurnPosition(bytes calldata _data) external checkDelegateCall nonReentrant {
        // struct BurnParams {
        //     uint256 tokenId;
        //     uint128 liquidity;
        //     uint256 amount0Min;
        //     uint256 amount1Min;
        //     uint256 deadline;
        // }

        INonfungiblePositionManager.DecreaseLiquidityParams memory burnParams = abi.decode(
            _data,
            (INonfungiblePositionManager.DecreaseLiquidityParams)
        );

        _checkOwnershipOfPosition(burnParams.tokenId);

        UniV3Pos memory posInfo = _getPositionData(burnParams.tokenId);

        burnParams.liquidity = posInfo.liquidity;

        (address _target, bytes32 _withdrawalHash) = _getTarget();

        if (burnParams.liquidity > 0) {
            _decreaseLiquidity(posInfo, burnParams, _target, _withdrawalHash, true);
        }

        nfpm.burn(burnParams.tokenId);

        uint256[] memory ids = new uint256[](1);
        ids[0] = burnParams.tokenId;

        emit PositionBurnedUnoV3(address(nfpm), burnParams.tokenId, PROTOCOL());
    }

    /**
     * @notice Executes decreasing of liquidity for a position on Uniswap V3
     * @param _data - encoded DecreaseLiquidityParams struct
     */
    function delegatedDecreaseLiquidity(bytes calldata _data) external checkDelegateCall nonReentrant {
        INonfungiblePositionManager.DecreaseLiquidityParams memory decLiqParams = abi.decode(
            _data,
            (INonfungiblePositionManager.DecreaseLiquidityParams)
        );

        UniV3Pos memory posInfo = _getPositionData(decLiqParams.tokenId);

        (address _target, bytes32 _withdrawalHash) = _getTarget();

        _decreaseLiquidity(posInfo, decLiqParams, _target, _withdrawalHash, false);
    }

    /**
     * @notice Executes increasing of liquidity for a position on Uniswap V3
     * @param _data - encoded IncreaseLiquidityParams struct
     */
    function delegateIncreaseLiquidity(bytes calldata _data) external checkDelegateCall nonReentrant {
        // struct IncreaseLiquidityParams {
        //     uint256 tokenId;
        //     uint128 liquidity;
        //     uint256 amount0Desired;
        //     uint256 amount1Desired;
        //     uint256 amount0Min;
        //     uint256 amount1Min;
        //     uint256 deadline;
        // }

        INonfungiblePositionManager.IncreaseLiquidityParams memory incLiqParams = abi.decode(
            _data,
            (INonfungiblePositionManager.IncreaseLiquidityParams)
        );

        _checkOwnershipOfPosition(incLiqParams.tokenId);

        // Fetch position data
        UniV3Pos memory posInfo = _getPositionData(incLiqParams.tokenId);

        (address token0, address token1) = (posInfo.token0, posInfo.token1);

        if (!IPoolWhitelist(address(this)).isTokenAllowed(token0))
            revert IPoolWhitelist.TokenIsNotAllowed(posInfo.token0);
        if (!IPoolWhitelist(address(this)).isTokenAllowed(token1)) revert IPoolWhitelist.TokenIsNotAllowed(token1);

        address _nfpm = address(nfpm);

        SafeOPS._forceApprove(token0, _nfpm, incLiqParams.amount0Desired);
        SafeOPS._forceApprove(token1, _nfpm, incLiqParams.amount1Desired);

        (uint128 liquidityIncreased, uint256 amount0Increased, uint256 amount1Increased) = nfpm.increaseLiquidity(
            incLiqParams
        );
        if (amount0Increased > 0) {
            if (amount0Increased < incLiqParams.amount0Desired) {
                IERC20(token0).approve(_nfpm, 0);
            }
        }
        if (amount1Increased > 0) {
            if (amount1Increased < incLiqParams.amount1Desired) {
                IERC20(token1).approve(_nfpm, 0);
            }
        }

        emit PositionIncreasedUnoV3(
            token0,
            token1,
            _nfpm,
            incLiqParams.tokenId,
            liquidityIncreased,
            amount0Increased,
            amount1Increased,
            PROTOCOL()
        );
    }

    /**
     * @inheritdoc IERC721Controller
     */
    function encodePartialWithdrawalERC721(
        address,
        uint256 _tokenId,
        uint256 _numerator,
        uint256 _denominator
    ) external view override returns (bytes[] memory withdrawalTxs) {
        // Fetch the current liquidity from the position
        UniV3Pos memory posInfo = _getPositionData(_tokenId);

        uint128 liquidityToRemove = uint128((uint256(posInfo.liquidity) * _numerator) / _denominator);

        (uint256 feeAmount0, uint256 feeAmount1) = _getPendingFeesFromPos(swapFactory, posInfo);

        bool positionWithFees = feeAmount0 > 0 || feeAmount1 > 0;
        bool needToDecrease = liquidityToRemove < posInfo.liquidity;
        bool needToBurn = liquidityToRemove == posInfo.liquidity && liquidityToRemove > 0;

        uint8 txCount = positionWithFees ? 1 : 0;
        txCount += needToDecrease || needToBurn ? 1 : 0;

        if (txCount == 0) return withdrawalTxs;

        withdrawalTxs = new bytes[](txCount);
        txCount = 0;

        if (positionWithFees) {
            // Encode the collect fees function call
            withdrawalTxs[txCount] = abi.encodeCall(
                UnoswapV3Controller.delegatedCollectAllFees,
                abi.encode(
                    INonfungiblePositionManager.CollectParams({
                        tokenId: _tokenId,
                        recipient: address(this),
                        amount0Max: type(uint128).max,
                        amount1Max: type(uint128).max
                    })
                )
            );
            ++txCount;
        }
        // Encode the burn position function call
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager
            .DecreaseLiquidityParams({
                tokenId: _tokenId,
                liquidity: liquidityToRemove,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            });
        if (liquidityToRemove > 0) {
            (decreaseParams.amount0Min, decreaseParams.amount1Min) = _getAmountsForLiquidity(
                TWAP_PERIOD(),
                _computePoolAddr(
                    swapFactory,
                    PoolKey({token0: posInfo.token0, token1: posInfo.token1, fee: posInfo.fee})
                ),
                liquidityToRemove,
                posInfo.tickLower,
                posInfo.tickUpper
            );
            // Add slippage tolerance from TWAP price
            (decreaseParams.amount0Min, decreaseParams.amount1Min) = (
                (decreaseParams.amount0Min * 90) / 100,
                (decreaseParams.amount1Min * 90) / 100
            );

            if (needToDecrease) {
                withdrawalTxs[txCount] = abi.encodeCall(
                    UnoswapV3Controller.delegatedDecreaseLiquidity,
                    abi.encode(decreaseParams)
                );
            } else {
                withdrawalTxs[txCount] = abi.encodeCall(
                    UnoswapV3Controller.delegateBurnPosition,
                    abi.encode(decreaseParams)
                );
            }
        } else {
            withdrawalTxs[txCount] = abi.encodeCall(
                UnoswapV3Controller.delegateBurnPosition,
                abi.encode(decreaseParams)
            );
        }
    }

    function delegatedCollectAllFees(bytes calldata _data) external {
        // struct CollectAllFeesParams {
        //     uint256 tokenId;
        //     address recipient;
        //     uint128 amount0Max;
        //     uint128 amount1Max;
        // }

        INonfungiblePositionManager.CollectParams memory collectParams = abi.decode(
            _data,
            (INonfungiblePositionManager.CollectParams)
        );

        _checkOwnershipOfPosition(collectParams.tokenId);

        UniV3Pos memory posInfo = _getPositionData(collectParams.tokenId);

        // Only UFarmPool can be the recipient of all fees
        collectParams.recipient = address(this);

        _collectFees(posInfo, collectParams, bytes32(0));
    }

    /**
     * @notice Computes amounts and fees of token0 and token1 in position
     * @param positionId - positionId to get amounts for
     * @return amount0 - amount of token0 in position
     * @return amount1 - amount of token1 in position
     */
    function getAmountsFromPosition(
        uint128 positionId
    ) external view returns (uint256 amount0, uint256 amount1, uint256 feeAmount0, uint256 feeAmount1) {
        UniV3Pos memory posInfo = _getPositionData(positionId);

        address pool = _computePoolAddr(
            swapFactory,
            PoolKey({token0: posInfo.token0, token1: posInfo.token1, fee: posInfo.fee})
        );

        (amount0, amount1) = _getAmountsForLiquidity(
            TWAP_PERIOD(),
            pool,
            posInfo.liquidity,
            posInfo.tickLower,
            posInfo.tickUpper
        );

        (feeAmount0, feeAmount1) = _getPendingFeesFromPos(swapFactory, posInfo);
    }

    /**
     * @notice Computes amounts and fees of token0 and token1 in position
     * @param positionId - positionId to get amounts for
     * @return amount0 - amount of token0 in position
     * @return amount1 - amount of token1 in position
     */
    function getPureAmountsFromPosition(
        uint256 positionId
    ) public view returns (uint256 amount0, uint256 amount1, uint256 feeAmount0, uint256 feeAmount1) {
        UniV3Pos memory positionData = _getPositionData(positionId);

        IUniswapV3Pool pool = IUniswapV3Pool(
            _computePoolAddr(
                swapFactory,
                PoolKey({token0: positionData.token0, token1: positionData.token1, fee: positionData.fee})
            )
        );

        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        (amount0, amount1) = nfpm.principal(positionId, sqrtPriceX96);
        (feeAmount0, feeAmount1) = nfpm.fees(positionId);
    }

    /**
     * @notice Returns liquidity amount for specified amounts of tokens
     * @param token0 - token0 address
     * @param token1 - token1 address
     * @param fee - pool fee
     * @param tickLower - lower tick of position
     * @param tickUpper - upper tick of position
     * @param amount0Desired - amount of token0 desired
     * @param amount1Desired - amount of token1 desired
     */
    function getLiquidityForAmounts(
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) external view returns (uint128 liquidity) {
        // Ensure the token addresses are ordered correctly for Uniswap V3
        (address tokenA, address tokenB) = token0 < token1 ? (token0, token1) : (token1, token0);
        (uint256 amountA, uint256 amountB) = token0 < token1
            ? (amount0Desired, amount1Desired)
            : (amount1Desired, amount0Desired);

        // Calculate the pool address
        IUniswapV3Pool pool = IUniswapV3Pool(
            _computePoolAddr(swapFactory, PoolKey({token0: tokenA, token1: tokenB, fee: fee}))
        );

        // Fetch the current price of the pool
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();

        // Calculate the square root prices for the specified tick range
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

        // Compute the liquidity amount
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            amountA,
            amountB
        );
    }

    function _getPositionData(uint256 id) internal view returns (UniV3Pos memory posInfo) {
        (bool success, bytes memory result) = address(nfpm).staticcall(abi.encodeCall(nfpm.positions, (id)));

        if (!success) revert POSITION_NOT_FOUND();

        posInfo = abi.decode(result, (UniV3Pos));
    }

    function _delegatedThisController() private view returns (address payable thisController) {
        thisController = payable(IUFarmCore(IUFarmPool(address(this)).ufarmCore()).controllers(PROTOCOL()));
        if (thisController == address(0)) revert FETCHING_CONTROLLER_FAILED();
    }

    function _getAmountsForLiquidity(
        uint32 _TWAP_PERIOD,
        address _pool,
        uint128 _liquidity,
        int24 _tickLower,
        int24 _tickUpper
    ) public view returns (uint256 amount0, uint256 amount1) {
        uint160 sqrtPriceX96 = getTWAPsqrt(_TWAP_PERIOD, _pool);

        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(_tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(_tickUpper);

        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            sqrtRatioAX96,
            sqrtRatioBX96,
            _liquidity
        );
    }

    function _decreaseLiquidity(
        UniV3Pos memory posInfo,
        INonfungiblePositionManager.DecreaseLiquidityParams memory decLiqParams,
        address _target,
        bytes32 _withdrawalHash,
        bool addAllFees
    ) internal returns (uint256 amount0Decreased, uint256 amount1Decreased) {
        (amount0Decreased, amount1Decreased) = nfpm.decreaseLiquidity(decLiqParams);

        emit PositionDecreasedUnoV3(
            posInfo.token0,
            posInfo.token1,
            address(nfpm),
            decLiqParams.tokenId,
            decLiqParams.liquidity,
            amount0Decreased,
            amount1Decreased,
            PROTOCOL()
        );

        (amount0Decreased, amount1Decreased) = _collectFees(
            posInfo,
            INonfungiblePositionManager.CollectParams({
                tokenId: decLiqParams.tokenId,
                recipient: _target,
                amount0Max: addAllFees ? type(uint128).max : uint128(amount0Decreased),
                amount1Max: addAllFees ? type(uint128).max : uint128(amount1Decreased)
            }),
            _withdrawalHash
        );
    }

    function _collectFees(
        UniV3Pos memory posInfo,
        INonfungiblePositionManager.CollectParams memory collectParams,
        bytes32 _withdrawalHash
    ) internal returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = nfpm.collect(collectParams);

        (address token0, address token1) = (posInfo.token0, posInfo.token1);
        address target = collectParams.recipient;

        if (target == address(this)) {} else {
            emit IUFarmPool.Withdraw(target, token0, amount0, _withdrawalHash);
            emit IUFarmPool.Withdraw(target, token1, amount1, _withdrawalHash);
        }

        emit FeesCollectedUnoV3(
            address(nfpm),
            token0,
            token1,
            target,
            collectParams.tokenId,
            amount0,
            amount1,
            PROTOCOL()
        );
    }

    /**
     * @dev Converts a tick value to a price.
     * @param _tick The tick value to convert.
     * @return price The corresponding price.
     */
    function tickToPrice(int24 _tick) public pure returns (uint256 price) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(_tick);
        price = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96)) >> (2 * FixedPoint96.RESOLUTION);
    }

    function _checkOwnershipOfPosition(uint256 tokenId) internal view {
        try nfpm.ownerOf(tokenId) returns (address owner) {
            if (owner != address(this)) revert INVALID_POSITION_OWNER();
        } catch {
            revert POSITION_NOT_FOUND();
        }
    }

    function _computePoolAddr(address factory, PoolKey memory key) internal view returns (address pool) {
        require(key.token0 < key.token1);
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            factory,
                            keccak256(abi.encode(key.token0, key.token1, key.fee)),
                            POOL_INIT_CODE_HASH
                        )
                    )
                )
            )
        );
    }

    function _getPendingFeesFromPos(
        address uniswapV3Factory,
        UniV3Pos memory feeParams
    ) public view returns (uint256 amount0, uint256 amount1) {
        (uint256 poolFeeGrowthInside0LastX128, uint256 poolFeeGrowthInside1LastX128) = _getFeeGrowthInside(
            IUniswapV3Pool(
                _computePoolAddr(
                    uniswapV3Factory,
                    PoolKey({token0: feeParams.token0, token1: feeParams.token1, fee: feeParams.fee})
                )
            ),
            feeParams.tickLower,
            feeParams.tickUpper
        );

        if (poolFeeGrowthInside0LastX128 > feeParams.feeGrowthInside0LastX128) {
            amount0 =
                ((poolFeeGrowthInside0LastX128 - feeParams.feeGrowthInside0LastX128) * feeParams.liquidity) /
                FixedPoint128.Q128 +
                feeParams.tokensOwed0;
        } else {
            amount0 = feeParams.tokensOwed0;
        }

        if (poolFeeGrowthInside1LastX128 > feeParams.feeGrowthInside1LastX128) {
            amount1 =
                ((poolFeeGrowthInside1LastX128 - feeParams.feeGrowthInside1LastX128) * feeParams.liquidity) /
                FixedPoint128.Q128 +
                feeParams.tokensOwed1;
        } else {
            amount1 = feeParams.tokensOwed1;
        }
    }

    function _getFeeGrowthInside(
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper
    ) private view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) {
        (, int24 tickCurrent, , , , , ) = pool.slot0();
        (, , uint256 lowerFeeGrowthOutside0X128, uint256 lowerFeeGrowthOutside1X128, , , , ) = pool.ticks(tickLower);
        (, , uint256 upperFeeGrowthOutside0X128, uint256 upperFeeGrowthOutside1X128, , , , ) = pool.ticks(tickUpper);

        if (tickCurrent < tickLower) {
            // Ensure no underflow happens
            if (lowerFeeGrowthOutside0X128 >= upperFeeGrowthOutside0X128) {
                feeGrowthInside0X128 = lowerFeeGrowthOutside0X128 - upperFeeGrowthOutside0X128;
            } else {
                feeGrowthInside0X128 = 0;
            }

            if (lowerFeeGrowthOutside1X128 >= upperFeeGrowthOutside1X128) {
                feeGrowthInside1X128 = lowerFeeGrowthOutside1X128 - upperFeeGrowthOutside1X128;
            } else {
                feeGrowthInside1X128 = 0;
            }
        } else if (tickCurrent < tickUpper) {
            (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128) = (
                pool.feeGrowthGlobal0X128(),
                pool.feeGrowthGlobal1X128()
            );

            // Ensure no underflow happens
            if (feeGrowthGlobal0X128 >= lowerFeeGrowthOutside0X128 + upperFeeGrowthOutside0X128) {
                feeGrowthInside0X128 = feeGrowthGlobal0X128 - lowerFeeGrowthOutside0X128 - upperFeeGrowthOutside0X128;
            } else {
                feeGrowthInside0X128 = 0;
            }

            if (feeGrowthGlobal1X128 >= lowerFeeGrowthOutside1X128 + upperFeeGrowthOutside1X128) {
                feeGrowthInside1X128 = feeGrowthGlobal1X128 - lowerFeeGrowthOutside1X128 - upperFeeGrowthOutside1X128;
            } else {
                feeGrowthInside1X128 = 0;
            }
        } else {
            // Ensure no underflow happens
            if (upperFeeGrowthOutside0X128 >= lowerFeeGrowthOutside0X128) {
                feeGrowthInside0X128 = upperFeeGrowthOutside0X128 - lowerFeeGrowthOutside0X128;
            } else {
                feeGrowthInside0X128 = 0;
            }

            if (upperFeeGrowthOutside1X128 >= lowerFeeGrowthOutside1X128) {
                feeGrowthInside1X128 = upperFeeGrowthOutside1X128 - lowerFeeGrowthOutside1X128;
            } else {
                feeGrowthInside1X128 = 0;
            }
        }
    }
}
