// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

/// CONTRACTS
import {ChainlinkedOracle} from './ChainlinkedOracle.sol';
import {UFarmCoreLink} from '../../shared/UFarmCoreLink.sol';
import {UFarmOwnableUUPS} from '../../shared/UFarmOwnableUUPS.sol';

/// INTERFACES
import {IPriceOracle} from './IPriceOracle.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC721} from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import {IUFarmPool} from '../pool/IUFarmPool.sol';
import {IUFarmCore} from '../core/IUFarmCore.sol';
import {ICoreWhitelist} from '../core/CoreWhitelist.sol';
import {AggregatorV3Interface} from '@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol';
import {IController, IERC20CommonController, IERC20SynthController, IERC721Controller} from '../controllers/IController.sol';
import {AssetsStructs} from '../../shared/AssetController.sol';
import {UFarmErrors} from '../../shared/UFarmErrors.sol';

/// LIBRARIES
import {UFarmMathLib} from '../../shared/UFarmMathLib.sol';

/**
 * @title PriceOracleCore contract
 * @author https://ufarm.digital/
 * @notice Connects to Chainlink price feeds and calculates the cost of assets
 */
abstract contract PriceOracleCore is
	IPriceOracle,
	UFarmCoreLink,
	ChainlinkedOracle,
	UFarmOwnableUUPS
{
	error InvalidPath();
	error InvalidMethod();
	error InvalidRecipient();
	error InvalidController();

	/**
	 * @inheritdoc IPriceOracle
	 */
	function getCostERC20(
		address tokenIn,
		uint256 amountIn,
		address tokenOut
	) public view virtual returns (uint256 cost) {
		(
			ICoreWhitelist.AssetWithPriceFeed memory baseFeed,
			ICoreWhitelist.AssetWithPriceFeed memory quoteFeed
		) = (
				ICoreWhitelist(ufarmCore()).tokenInfo(tokenIn),
				ICoreWhitelist(ufarmCore()).tokenInfo(tokenOut)
			);

		if (baseFeed.priceFeed.feedAddr == address(0)) revert ChainlinkOracleNotSet(baseFeed.assetAddr);
		if (quoteFeed.priceFeed.feedAddr == address(0))
			revert ChainlinkOracleNotSet(quoteFeed.assetAddr);

		(int256 basePrice, int256 quotePrice) = getNormalizedPrice(
			baseFeed.priceFeed.feedAddr,
			baseFeed.priceFeed.feedDec,
			quoteFeed.priceFeed.feedAddr,
			quoteFeed.priceFeed.feedDec
		);

		cost = uint256((int256(amountIn) * basePrice) / quotePrice);
		cost = uint256(
			UFarmMathLib.convertDecimals(int256(cost), baseFeed.assetDec, quoteFeed.assetDec)
		);
	}

	/**
	 * @notice Returns the normalized price of the base and quote tokens
	 * @param _baseOracle - address of the base token's oracle
	 * @param _baseOracleDecimals - decimals of the base oracle
	 * @param _quoteOracle - address of the quote oracle
	 * @param _quoteOracleDecimals - decimals of the quote token's oracle
	 * @return basePrice - price of the base token
	 * @return quotePrice - price of the quote token
	 */
	function getNormalizedPrice(
		address _baseOracle,
		uint8 _baseOracleDecimals,
		address _quoteOracle,
		uint8 _quoteOracleDecimals
	) public view returns (int256 basePrice, int256 quotePrice) {
		uint8 biggerDecimals = _baseOracleDecimals > _quoteOracleDecimals
			? _baseOracleDecimals
			: _quoteOracleDecimals;

		basePrice = _chainlinkLatestAnswer(_baseOracle);
		basePrice = UFarmMathLib.convertDecimals(basePrice, _baseOracleDecimals, biggerDecimals);

		quotePrice = _chainlinkLatestAnswer(_quoteOracle);
		quotePrice = UFarmMathLib.convertDecimals(quotePrice, _quoteOracleDecimals, biggerDecimals);

		return (basePrice, quotePrice);
	}

	/**
	 * @inheritdoc IPriceOracle
	 */
	function getCostControlledERC20(
		address tokenIn,
		uint256 amountIn,
		address tokenOut,
		address controller
	) public view returns (uint256 cost) {
		try IERC20SynthController(controller).getCostControlledERC20(tokenIn, amountIn, tokenOut) returns (uint256 cost20) {
			cost = cost20;
		} catch {
			cost = 0;
		}
	}

	/**
	 * @inheritdoc IPriceOracle
	 */
	function getCostERC721(
		address tokenIn,
		uint256[] memory ids,
		address tokenOut,
		address controller
	) public view returns (uint256 cost) {
		try IERC721Controller(controller).getCostControlledERC721(tokenIn, ids, tokenOut) returns (uint256 cost721) {
			cost = cost721;
		} catch {
			cost = 0;
		}
	}

	/**
	 * @notice Returns total cost of the pool in value token
	 * @dev Doesn't check if pool is pool.
	 * @param _ufarmPool - address of the pool
	 * @param _valueToken - address of the value token
	 */
	function getTotalCostOfPool(
		address _ufarmPool,
		address _valueToken
	) external view returns (uint256 totalCost) {
		IUFarmPool pool = IUFarmPool(_ufarmPool);
		IUFarmCore core = IUFarmCore(pool.ufarmCore());

		// gas saving
		uint256 length;
		address thisAsset;
		address controllerAddr;

		// common erc20 block
		{
			address[] memory nonZeroAssets = pool.erc20CommonAssets();
			length = nonZeroAssets.length;
			uint256 balanceOfAsset;
			for (uint256 i; i < length; ++i) {
				thisAsset = nonZeroAssets[i];
				balanceOfAsset = IERC20(thisAsset).balanceOf(_ufarmPool);
				totalCost += thisAsset == _valueToken
					? balanceOfAsset
					: getCostERC20(thisAsset, balanceOfAsset, _valueToken);
			}
		}

		// controlled erc20 block
		{
			AssetsStructs.ControlledERC20[] memory controlledAssets20 = pool.erc20ControlledAssets();
			length = controlledAssets20.length;

			for (uint256 i; i < length; ++i) {
				thisAsset = controlledAssets20[i].addr;
				controllerAddr = core.controllers(controlledAssets20[i].controller);
				if (controllerAddr == address(0)) revert InvalidController();
				totalCost += getCostControlledERC20(
					thisAsset,
					IERC20(thisAsset).balanceOf(_ufarmPool),
					_valueToken,
					controllerAddr
				);
			}
		}

		// controlled erc721 block
		{
			AssetsStructs.ControlledERC721[] memory controlledAssets721 = pool.erc721ControlledAssets();
			length = controlledAssets721.length;

			AssetsStructs.ControlledERC721 memory controlledAsset721;

			for (uint256 i; i < length; ++i) {
				controlledAsset721 = controlledAssets721[i];
				controllerAddr = core.controllers(controlledAsset721.controller);
				if (controllerAddr == address(0)) revert InvalidController();
				totalCost += getCostERC721(
					controlledAsset721.addr,
					controlledAsset721.ids,
					_valueToken,
					controllerAddr
				);
			}
		}
	}

	function __init__PriceOracleCore(address ufarmCoreLink) internal onlyInitializing {
		__init__UFarmOwnableUUPS();
		__init__UFarmCoreLink(ufarmCoreLink);
		__init__ChainlinkedOracle(HOUR * 25); // 25 hours
	}

	uint256[50] private __gap;
}
