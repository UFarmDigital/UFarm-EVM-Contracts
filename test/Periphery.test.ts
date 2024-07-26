// SPDX-License-Identifier: UNLICENSED

import { expect } from 'chai'
import { loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import hre, { ethers } from 'hardhat'
import { Multicall, ContractCallResults, ContractCallContext } from 'ethereum-multicall'
import { tokensFixture, UniswapV3Fixture } from './_fixtures'
import {
	IERC20Metadata,
	IERC20Metadata__factory,
	INonfungiblePositionManager,
	Multicall3__factory,
} from '../typechain-types'
import {
	constants,
	getBlockchainTimestamp,
	MintableToken,
	mintTokens,
	safeApprove,
} from './_helpers'
import { customSetTimeout } from '../scripts/_deploy_helpers'

import {
	Pool,
	TickMath,
	nearestUsableTick,
	Position,
	maxLiquidityForAmounts,
} from '@uniswap/v3-sdk'
import { BigintIsh } from '@uniswap/sdk-core'

import JSBI from 'jsbi'

describe('Multicall', async () => {
	it('Should return correct results for multiple calls', async () => {
		const { tokens, deployer } = await loadFixture(tokensFixture)

		const multicall_factory = (await hre.ethers.getContractFactory(
			'Multicall3',
		)) as Multicall3__factory

		const multicall_instance = await multicall_factory.deploy()

		// mint tokens to deployer and prepare for multicall
		let multicall_contexts: ContractCallContext[] = []

		const balanceOfCall: ContractCallContext = {
			reference: 'testContract2',
			contractAddress: '0x6795b15f3b16Cf8fB3E56499bbC07F6261e9b0C3',
			abi: [
				{
					name: 'balanceOf',
					type: 'function',
					stateMutability: 'view',
					inputs: [{ name: 'account', type: 'address' }],
					outputs: [{ name: 'amounts', type: 'uint256' }],
				},
			],
			calls: [
				{
					reference: 'balanceOfCall',
					methodName: 'balanceOf',
					methodParameters: [deployer.address],
				},
			],
		}

		await Promise.all(
			Object.values(tokens).map(async (token) => {
				// if WETH (has attribute 'deposit') then deposit 1 ETH
				if ('deposit' in token) {
					await token.deposit({ value: (10n ** 18n).toString() })
				}
				// else if USDT (has attribute 'mint') then mint 1 USDT
				else if ('mint' in token) {
					await token.mint(deployer.address, (10n ** 6n).toString())
				} else {
					throw new Error('Unknown token')
				}
				multicall_contexts.push({
					...balanceOfCall,
					reference: await token.symbol(),
					contractAddress: token.address,
				})
			}),
		)

		const multicall = new Multicall({
			ethersProvider: hre.ethers.provider,
			tryAggregate: false,
			multicallCustomContractAddress: multicall_instance.address,
		})

		expect(await multicall.call(multicall_contexts)).to.be.not.reverted
	})

	it.skip(`UniswapV3 tick calculation test`, async () => {
		const all = await loadFixture(UniswapV3Fixture)

		const UNIV3 = {
			FEE_TICK: {
				zero01: 5,
				zero05: 10,
				zero3: 60,
				one: 200,
			},
			MIN_TICK: -887272,
			MAX_TICK: 887272,
			MIN_SQRT_RATIO: BigInt(4295128739),
			MAX_SQRT_RATIO: BigInt('1461446703485210103287273052203988822378723970342'),
		}
		const ONE = BigInt(1e18)

		const Q96 = 2n ** 96n // Equivalent to the Solidity's type uint256 for the Q96 format in sqrtPrice

		async function getCurrentPrice(pool: string, decimalsA: number, decimalsB: number) {
			const pool_instance = await ethers.getContractAt('UniswapV3Pool', pool, signer)
			const slot0 = await pool_instance.slot0()
			const sqrtPriceX96 = slot0.sqrtPriceX96.toBigInt()
			const nonNormalisedPrice = (Number(sqrtPriceX96) / 2 ** 96) ** 2
			const _buyOneOfToken0 = ((nonNormalisedPrice * 10 ** decimalsA) / 10 ** decimalsB).toFixed(
				decimalsB,
			)
			const buyOneOfToken0 = ethers.utils.parseUnits(_buyOneOfToken0, decimalsB).toBigInt()
			const _buyOneOfToken1 = (1 / Number(_buyOneOfToken0)).toFixed(decimalsA)
			const buyOneOfToken1 = ethers.utils.parseUnits(_buyOneOfToken1, decimalsA).toBigInt()

			console.log(`Price A of B: ${buyOneOfToken0}\nPrice B of A: ${buyOneOfToken1}`)

			return { buyOneOfToken0, buyOneOfToken1 }
		}

		function getTickAtSqrtRatio(sqrtRatioX96: bigint): number {
			const sqrtPrice = Number(sqrtRatioX96) / Number(Q96)
			return Math.floor((Math.log(sqrtPrice) / Math.log(1.0001)) * 2)
		}

		function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
			const sqrtPrice = Number(sqrtPriceX96) / Number(Q96)
			return sqrtPrice * sqrtPrice
		}

		function priceToSqrtPriceX96(price: number): bigint {
			const sqrtPrice = Math.sqrt(price)
			return BigInt(Math.floor(sqrtPrice * Number(Q96)))
		}

		let tokenA: MintableToken = all.tokens.WETH
		let tokenB: MintableToken = all.tokens.USDT

		const reversed = BigInt(tokenA.address) > BigInt(tokenB.address)

		if (reversed) {
			;[tokenA, tokenB] = [tokenB, tokenA]
		}

		const [decimalsA, decimalsB, symbolA, symbolB] = await Promise.all([
			tokenA.decimals(),
			tokenB.decimals(),
			tokenA.symbol(),
			tokenB.symbol(),
		])

		const fee = 500

		const uniswapV3Factory_instance = all.uniswapV3Factory_instance
		const nfpm_instance = all.nonFungPosManager_instance

		const signer = all.wallet

		const pool = await uniswapV3Factory_instance.getPool(tokenA.address, tokenB.address, fee)
		const pool_instance = await ethers.getContractAt('UniswapV3Pool', pool, signer)
		const slot0_initial = await pool_instance.slot0()

		function maxLiquidityForAmount0Precise(
			sqrtRatioAX96: JSBI,
			sqrtRatioBX96: JSBI,
			amount0: BigintIsh,
		): JSBI {
			if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
				;[sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96]
			}

			const numerator = JSBI.multiply(
				JSBI.multiply(JSBI.BigInt(amount0), sqrtRatioAX96),
				sqrtRatioBX96,
			)
			const denominator = JSBI.multiply(
				JSBI.BigInt(Q96.toString()),
				JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96),
			)

			return JSBI.divide(numerator, denominator)
		}

		/**
		 * Computes the maximum amount of liquidity received for a given amount of token1
		 * @param sqrtRatioAX96 The price at the lower tick boundary
		 * @param sqrtRatioBX96 The price at the upper tick boundary
		 * @param amount1 The token1 amount
		 * @returns liquidity for amount1
		 */
		function maxLiquidityForAmount1(
			sqrtRatioAX96: JSBI,
			sqrtRatioBX96: JSBI,
			amount1: BigintIsh,
		): JSBI {
			if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
				;[sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96]
			}
			return JSBI.divide(
				JSBI.multiply(JSBI.BigInt(amount1), JSBI.BigInt(Q96.toString())),
				JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96),
			)
		}

		/**
		 * Gets the amount1 delta between two prices
		 * @dev Calculates liquidity * (sqrt(upper) - sqrt(lower))
		 * @param sqrtRatioAX96 The price at the lower tick boundary
		 * @param sqrtRatioBX96 The price at the upper tick boundary
		 * @param liquidity The liquidity amount
		 * @param roundUp Whether to round the amount up, or down
		 * @returns Amount of token1 required to cover a position of size liquidity between the two passed prices
		 */
		function getAmount1Delta(
			sqrtRatioAX96: JSBI,
			sqrtRatioBX96: JSBI,
			liquidity: JSBI,
			roundUp: boolean,
		): JSBI {
			if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
				;[sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96]
				console.log(`Swapped prices`)
			}

			const answer = roundUp
				? JSBI.divide(
						JSBI.multiply(
							JSBI.BigInt(liquidity.toString()),
							JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96),
						),
						JSBI.BigInt(Q96.toString()),
				  )
				: JSBI.divide(
						JSBI.multiply(
							JSBI.BigInt(liquidity.toString()),
							JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96),
						),
						JSBI.BigInt(Q96.toString()),
				  )

			return answer
		}

		/**
		 * Gets the amount0 delta between two prices
		 * @dev Calculates liquidity / sqrt(lower) - liquidity / sqrt(upper),
		 * @param sqrtRatioAX96 - A sqrt price
		 * @param sqrtRatioBX96 - Another sqrt price
		 * @param liquidity - The amount of usable liquidity
		 * @param roundUp - Whether to round the amount up or down
		 * @returns
		 */
		function getAmount0Delta(
			sqrtRatioAX96: JSBI,
			sqrtRatioBX96: JSBI,
			liquidity: JSBI,
			roundUp: boolean,
		): JSBI {
			if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
				;[sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96]
			}

			const numerator1 = JSBI.leftShift(JSBI.BigInt(liquidity.toString()), JSBI.BigInt(96))
			const numerator2 = JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96)

			const answer = roundUp
				? JSBI.divide(
						JSBI.divide(JSBI.multiply(numerator1, numerator2), sqrtRatioBX96),
						sqrtRatioAX96,
				  )
				: JSBI.divide(
						JSBI.divide(JSBI.multiply(numerator1, numerator2), sqrtRatioBX96),
						sqrtRatioAX96,
				  )

			return answer
		}

		// Set the tick spacing
		const tickSpacing = UNIV3.FEE_TICK.zero05

		const initialPrice = await getCurrentPrice(pool, decimalsA, decimalsB)
		const calculatedTick = getTickAtSqrtRatio(slot0_initial.sqrtPriceX96.toBigInt())

		// expect(calculatedTick).to.be.equal(
		// 	slot0_initial.tick,
		// 	'Initial tick should be equal to calculated tick',
		// )

		const calculatedPrice = BigInt(TickMath.getSqrtRatioAtTick(slot0_initial.tick).toString())
		const tickFromCalcualtedPrice = getTickAtSqrtRatio(calculatedPrice)

		// expect(calculatedTick).to.be.equal(
		// 	tickFromCalcualtedPrice,
		// 	'Initial tick should be equal to tickFromCalcualtedPrice',
		// )

		const [priceLowerBound, priceUpperBound] = [
			initialPrice.buyOneOfToken0 / 2n,
			initialPrice.buyOneOfToken0 * 2n,
		]

		const sqrtRatioAX96 = priceToSqrtPriceX96(Number(priceLowerBound))
		const sqrtRatioBX96 = priceToSqrtPriceX96(Number(priceUpperBound))

		const [tickLower, tickUpper] = [
			getTickAtSqrtRatio(sqrtRatioAX96),
			getTickAtSqrtRatio(sqrtRatioBX96),
		]

		console.log(
			`tick upper: ${tickUpper}\n` +
				`tick initial: ${slot0_initial.tick}\n` +
				`tick lower: ${tickLower}\n`,
		)

		// Determine the usable ticks given a tick spacing
		const roundedTickLower = nearestUsableTick(tickLower, tickSpacing)
		const roundedTickUpper = nearestUsableTick(tickUpper, tickSpacing)

		const roundedRatioAX96 = TickMath.getSqrtRatioAtTick(roundedTickLower)
		const roundedRatioBX96 = TickMath.getSqrtRatioAtTick(roundedTickUpper)

		const amountA = () => 10n ** BigInt(decimalsA) // like a user input, wait for it when met
		const amountB = () => 10n ** BigInt(decimalsB) // like a user input, wait for it when met

		// if (slot0_initial.tick < roundedTickLower) {
		// only amount0
		console.log(`Tick is less than lower bound`)

		const tickAbovePrice0 = nearestUsableTick(slot0_initial.tick + 100, tickSpacing)
		const sqrtPrice0Above = BigInt(TickMath.getSqrtRatioAtTick(tickAbovePrice0).toString())
		const price0Above = sqrtPriceX96ToPrice(sqrtPrice0Above)
		const price1Above = (price0Above * 3) / 2
		const _sqrtPrice1Above = priceToSqrtPriceX96(price1Above)
		const _tickAbovePrice1 = getTickAtSqrtRatio(_sqrtPrice1Above)
		const tickAbovePrice1 = nearestUsableTick(_tickAbovePrice1, tickSpacing)
		const sqrtPrice1Above = BigInt(TickMath.getSqrtRatioAtTick(tickAbovePrice1).toString())

		const liquidityAbove = maxLiquidityForAmounts(
			JSBI.BigInt(slot0_initial.sqrtPriceX96.toString()),
			JSBI.BigInt(sqrtPrice0Above.toString()),
			JSBI.BigInt(sqrtPrice1Above.toString()),
			JSBI.BigInt(amountA().toString()),
			JSBI.BigInt(0),
			true,
		)

		console.log(`Liquidity when current price below borders: \n${liquidityAbove.toString()}\n`)

		const amount0Above = getAmount0Delta(
			JSBI.BigInt(sqrtPrice0Above.toString()),
			JSBI.BigInt(sqrtPrice1Above.toString()),
			liquidityAbove,
			true,
		)

		const mintDataAbove: INonfungiblePositionManager.MintParamsStruct = {
			token0: tokenA.address,
			token1: tokenB.address,
			fee: fee,
			tickLower: tickAbovePrice0,
			tickUpper: tickAbovePrice1,
			amount0Desired: amount0Above.toString(),
			amount1Desired: 0,
			amount0Min: 0,
			amount1Min: 0,
			recipient: all.deployer.address,
			deadline: (await getBlockchainTimestamp(ethers.provider)) + 100,
		}

		let snapshotBeforeMint = await takeSnapshot()

		const aToSpend = amount0Above.toString()
		await mintTokens(tokenA, aToSpend, all.deployer)
		await safeApprove(tokenA, nfpm_instance.address, aToSpend, all.deployer)

		await nfpm_instance.mint(mintDataAbove)
		console.log(`Minted position upper price\n`)

		await snapshotBeforeMint.restore()
		snapshotBeforeMint = await takeSnapshot()

		// } else if (slot0_initial.tick < roundedTickUpper) {

		// amount0 and amount1

		console.log(`Tick is between bounds`)

		const liquidityInside = maxLiquidityForAmounts(
			JSBI.BigInt(slot0_initial.sqrtPriceX96.toString()),
			JSBI.BigInt(roundedRatioAX96.toString()),
			JSBI.BigInt(roundedRatioBX96.toString()),
			JSBI.BigInt(amountA().toString()),
			JSBI.BigInt(amountB().toString()),
			true,
		)

		const [amount0Inside, amount1Inside] = [
			getAmount0Delta(
				JSBI.BigInt(slot0_initial.sqrtPriceX96.toString()),
				JSBI.BigInt(roundedRatioAX96.toString()),
				liquidityInside,
				true,
			),
			getAmount1Delta(
				JSBI.BigInt(slot0_initial.sqrtPriceX96.toString()),
				JSBI.BigInt(roundedRatioBX96.toString()),
				liquidityInside,
				true,
			),
		]

		const mintDataInside: INonfungiblePositionManager.MintParamsStruct = {
			token0: tokenA.address,
			token1: tokenB.address,
			fee: fee,
			tickLower: roundedTickLower,
			tickUpper: roundedTickUpper,
			amount0Desired: amount0Inside.toString(),
			amount1Desired: amount1Inside.toString(),
			amount0Min: 0,
			amount1Min: 0,
			recipient: all.deployer.address,
			deadline: (await getBlockchainTimestamp(ethers.provider)) + 100,
		}

		const aInsideToSpend = amount0Inside.toString()
		const bInsideToSpend = amount1Inside.toString()

		await mintTokens(tokenA, aInsideToSpend, all.deployer)
		await mintTokens(tokenB, bInsideToSpend, all.deployer)
		await safeApprove(tokenA, nfpm_instance.address, aInsideToSpend, all.deployer)
		await safeApprove(tokenB, nfpm_instance.address, bInsideToSpend, all.deployer)

		await nfpm_instance.mint(mintDataInside)

		console.log(`Minted position inside price\n`)

		await snapshotBeforeMint.restore()

		// console.log(`Liquidity when current price above borders: \n${liquidityBelow.toString()}\n`)
		// } else {

		// amount1
		console.log(`Tick is below bounds`)

		console.log(`Tick is greater than upper bound`)
		const _tickBelowPrice1 = slot0_initial.tick - 100
		const tickBelowPrice1 = nearestUsableTick(_tickBelowPrice1, tickSpacing)
		const sqrtPrice1Below = BigInt(TickMath.getSqrtRatioAtTick(tickBelowPrice1).toString())
		const price1Below = sqrtPriceX96ToPrice(sqrtPrice1Below)
		const _price0Below = (price1Below * 2) / 3
		const _sqrtPrice0Below = priceToSqrtPriceX96(_price0Below)
		const _tickBelowPrice0 = getTickAtSqrtRatio(_sqrtPrice0Below)
		const tickBelowPrice0 = nearestUsableTick(_tickBelowPrice0, tickSpacing)
		const sqrtPrice0Below = BigInt(TickMath.getSqrtRatioAtTick(tickBelowPrice0).toString())
		const price0Below = sqrtPriceX96ToPrice(sqrtPrice0Below)

		const liquidityBelow = maxLiquidityForAmounts(
			JSBI.BigInt(slot0_initial.sqrtPriceX96.toString()),
			JSBI.BigInt(sqrtPrice0Below.toString()),
			JSBI.BigInt(sqrtPrice1Below.toString()),
			JSBI.BigInt(0),
			JSBI.BigInt(amountB().toString()), // user input like
			true,
		)

		console.log(`Liquidity when current price above borders: \n${liquidityBelow.toString()}\n`)

		const amount1Below = getAmount1Delta(
			JSBI.BigInt(sqrtPrice0Below.toString()),
			JSBI.BigInt(sqrtPrice1Below.toString()),
			liquidityBelow,
			false,
		)

		const mintDataBelow: INonfungiblePositionManager.MintParamsStruct = {
			token0: tokenA.address,
			token1: tokenB.address,
			fee: fee,
			tickLower: tickBelowPrice0,
			tickUpper: tickBelowPrice1,
			amount0Desired: 0,
			amount1Desired: amount1Below.toString(),
			amount0Min: 0,
			amount1Min: 0,
			recipient: all.deployer.address,
			deadline: (await getBlockchainTimestamp(ethers.provider)) + 100,
		}

		const bBelowToSpend = amount1Below.toString()
		await mintTokens(tokenB, bBelowToSpend, all.deployer)
		await safeApprove(tokenB, nfpm_instance.address, bBelowToSpend, all.deployer)

		await nfpm_instance.mint(mintDataBelow)

		console.log(`Minted position lower price\n`)

		await snapshotBeforeMint.restore()

		// }
	})

	it.skip('one inch fork test', async () => {
		const [deployer] = await hre.ethers.getSigners()
		console.log(`Deplyer address: ${deployer.address}`)

		const routerV6 = '0x111111125421ca6dc452d289314280a0f8842a65'
		const aggregationRouterV5_orig = '0x1111111254eeb25477b68fb85ed929f73a960582'
		const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
		const usdtAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7'
		const usdtHolderAddr = '0xDFd5293D8e347dFe59E90eFd55b2956a1343963d'
		const pureOneInchTx =
			'0x0502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000f374f00000000000000000000000000000000000000000000000000000000000f0d6d0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d03403041cbd36888becc7bbcbc0045e3b1f144466f5f8b1ccac8'

		const oneInchTx = `0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c80502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000f374f00000000000000000000000000000000000000000000000000000000000f0d6d0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d03403041cbd36888becc7bbcbc0045e3b1f144466f5f8b1ccac8000000000000000000000000000000000000000000000000`
		const selectorToController =
			'0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c8'

		// Get code of original myAggrRouterV5
		const code = await hre.ethers.provider.getCode(aggregationRouterV5_orig)
		if (code === '0x') {
			throw new Error('AggregationRouterV5 not deployed')
		} else {
			console.log(`AggregationRouterV5 code: ${code.slice(0, 10)}...`)
		}

		await await hre.ethers.provider.send('hardhat_impersonateAccount', [usdtHolderAddr])

		const usdtHolder = hre.ethers.provider.getSigner(usdtHolderAddr)
		console.log(`Impersonated usdt holder: ${usdtHolderAddr}`)

		const usdtInstance = (await hre.ethers.getContractAt(
			'@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
			usdtAddress,
		)) as IERC20Metadata
		const usdcInstance = (await hre.ethers.getContractAt(
			'@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
			usdcAddress,
		)) as IERC20Metadata

		const oneInchControllerFactory = await hre.ethers.getContractFactory('InchSwapTestController')
		const testProxyFactory = await hre.ethers.getContractFactory('InchSwapTestProxy')

		const aggregationRouterV5Factory = await hre.ethers.getContractFactory('AggregationRouterV5')
		const myAggrRouterV5 = await aggregationRouterV5Factory.deploy(
			'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
		)
		console.log(`AggregationRouterV5 deployed at: ${myAggrRouterV5.address}`)

		// const inchTarget = aggregationRouterV5_orig
		const inchTarget = myAggrRouterV5.address

		const testController = await oneInchControllerFactory.deploy(inchTarget)
		console.log(`test controller deployed at: ${testController.address}`)

		const testProxy = await testProxyFactory.deploy()
		console.log(`TestProxy deployed at: ${testProxy.address}`)

		const usdtInitialBalance = await usdtInstance.balanceOf(testProxy.address)
		const usdcInitialBalance = await usdcInstance.balanceOf(testProxy.address)

		console.log(`usdt initial balance: ${usdtInitialBalance.toString()}`)
		console.log(`usdc initial balance: ${usdcInitialBalance.toString()}`)

		await testProxy.addController(
			constants.UFarm.prtocols.OneInchProtocolString,
			testController.address,
		)
		console.log(`OneInchController added to TestProxy`)

		const usdtAmountOut = constants.ONE_HUNDRED_BUCKS.mul(20)

		if ((await usdtInstance.balanceOf(usdtHolderAddr)).lt(usdtAmountOut)) {
			throw new Error('usdtAmountOut is greater than balance of holder')
		}

		await customSetTimeout(2)

		await (await usdtInstance.connect(usdtHolder).transfer(testProxy.address, usdtAmountOut)).wait()
		console.log(`Transferred ${usdtAmountOut} USDT to TestProxy`)
		const logs = await (
			await usdtInstance.connect(usdtHolder).transfer(deployer.address, usdtAmountOut)
		).wait()
		// console.log(`Transferred ${JSON.stringify(logs,null,2)} USDT to Deployer`)

		await customSetTimeout(2)

		await safeApprove(usdtInstance, inchTarget, usdtAmountOut, deployer)

		console.log(`Approved ${usdtAmountOut} USDT to AggregationRouter from deployer`)

		await customSetTimeout(2)

		const usdtBalanceBeforeSwap = await usdtInstance.balanceOf(deployer.address)
		const usdtProxyBalanceBeforeSwap = await usdtInstance.balanceOf(testProxy.address)
		console.log(`usdt balance before deployer swap: ${usdtBalanceBeforeSwap.toString()}`)
		console.log(`usdt balance before proxy swap: ${usdtProxyBalanceBeforeSwap.toString()}`)

		const receipt1inch = await (
			await deployer.sendTransaction({ to: inchTarget, data: pureOneInchTx })
		).wait()

		console.log(`1inch swap executed #1 \n`)

		const usdcHolderBalanceAfter = await usdcInstance.balanceOf(deployer.address)

		console.log(`\n\nusdc balance after deployer swap: ${usdcHolderBalanceAfter.toString()}`)

		const controllerCall = testController.interface.encodeFunctionData(`delegated1InchSwap`, [
			pureOneInchTx,
		])
		try {
			await testProxy.protocolAction(constants.UFarm.prtocols.OneInchProtocolString, controllerCall)
			console.log(`1inch swap executed #2 \n`)
		} catch (e) {
			console.log(`Error: ${e}`)
		}

		try {
			await testProxy.justCall(usdtAddress, inchTarget, pureOneInchTx)
			console.log(`1inch swap executed #3`)
		} catch (e) {
			console.log(`Error: ${e}`)
		}
	})
})
