// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import bn from 'bignumber.js'
import hre from 'hardhat'
import { Signer, Contract } from 'ethers'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { LogDescription } from 'ethers/lib/utils'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
	BigNumberish,
	BigNumber,
	ContractTransaction,
	ContractReceipt,
	BaseContract,
	ContractFactory,
} from 'ethers'
import {
	AggregationRouterV5__factory,
	ERC20__factory,
	IChainlinkAggregator,
	IERC20,
	INonfungiblePositionManager,
	IQuoterV2,
	IUniswapV3Pool,
	Lido,
	MockedWETH9,
	NonfungiblePositionManager,
	PoolAdmin,
	QuoterV2,
	StableCoin,
	UFarmFund,
	UFarmPool,
	UniswapV2Factory,
	UniswapV2Router02,
	UniswapV3Factory,
	UnoswapV2Controller,
	WETH9,
	WETH9__factory,
	WstETH,
} from '../typechain-types'

import { JsonRpcProvider } from '@ethersproject/providers'
import { TypedData } from 'eip-712'
import { IERC20Metadata__factory } from '../typechain-types/factories/contracts/test/OneInch/contracts/AggregationRouterV5.sol'
import { Interface } from 'ethers/lib/utils'
import { abi as UnoswapV2ControllerABI } from '../artifacts/contracts/main/contracts/controllers/UnoswapV2Controller.sol/UnoswapV2Controller.json'
import { abi as UnoswapV3ControllerABI } from '../artifacts/contracts/main/contracts/controllers/UnoswapV3Controller.sol/UnoswapV3Controller.json'
import { abi as OneInchV5ControllerABI } from '../artifacts/contracts/main/contracts/controllers/OneInchV5Controller.sol/OneInchV5Controller.json'
import { IUFarmPool } from '../typechain-types/contracts/main/contracts/pool/PoolFactory.sol/PoolFactory'
import { UnoswapV3ControllerInterface } from '../typechain-types/contracts/main/contracts/controllers/UnoswapV3Controller.sol/UnoswapV3Controller'
import { OneInchV5ControllerInterface } from '../typechain-types/contracts/main/contracts/controllers/OneInchV5Controller.sol/OneInchV5Controller'

export type PromiseOrValue<T> = T | Promise<T>

export type PoolCreationStruct = IUFarmPool.CreationSettingsStruct
export type StaffStruct = IUFarmPool.StaffStruct

export interface PerformanceCommissionStep {
	step: BigNumberish
	commission: BigNumberish
}

export const getInitCodeHash = async (contract: Contract | string): Promise<string> => {
	try {
		if (typeof contract === 'string') {
			return ethers.utils.keccak256(contract)
		} else {
			const code = await contract.provider.getCode(contract.address)
			const initCodeHash = ethers.utils.keccak256(code)
			return initCodeHash
		}
	} catch (error) {
		console.error('Error occurred while getting code or hashing:', error)
		throw error
	}
}

export function toBigInt(value: BigNumberish): bigint {
	return BigInt(value.toString())
}

export function packPerformanceCommission(steps: PerformanceCommissionStep[]): BigNumber {
	const MAX_PERFORMANCE_FEE: number = 65535

	let packedPerformanceFee: bigint = BigInt(0)
	const stepsCount: number = steps.length

	if (stepsCount > 8) throw new Error('Too many performance fee steps')

	let previousStep: bigint = 0n
	let thisStep: PerformanceCommissionStep
	for (let i = 0; i < stepsCount; ++i) {
		thisStep = steps[i]
		if (toBigInt(thisStep.step) > previousStep || i === 0) {
			if (toBigInt(thisStep.commission) > toBigInt(MAX_PERFORMANCE_FEE)) {
				throw new Error(
					`Commission ${thisStep.commission} is out of range [0, ${MAX_PERFORMANCE_FEE}].`,
				)
			}
			previousStep = toBigInt(thisStep.step)
		}

		packedPerformanceFee |= toBigInt(thisStep.step) << toBigInt(i * 32) // Shift 'step' by 32 bits
		packedPerformanceFee |= toBigInt(thisStep.commission) << toBigInt(i * 32 + 16) // Shift 'commission' by 16 bits
	}
	return BigNumber.from(packedPerformanceFee)
}

export function unpackPerformanceCommission(
	packedPerformanceCommission: BigNumber,
): PerformanceCommissionStep[] {
	const MAX_PERFORMANCE_FEE: number = 65535
	const steps: PerformanceCommissionStep[] = []

	let packedValue: bigint = packedPerformanceCommission.toBigInt()

	for (let i = 0; i < 8; ++i) {
		const step: number = Number(packedValue & 0xffffn)
		packedValue >>= 16n // Shift right by 16 bits
		const commission: number = Number(packedValue & 0xffffn)
		packedValue >>= 16n // Shift right by 16 bits

		if (commission > MAX_PERFORMANCE_FEE) {
			throw new Error(`Commission ${commission} is out of range [0, ${MAX_PERFORMANCE_FEE}].`)
		}

		steps.push({ step, commission })
	}

	return steps
}

export type FeedWithDecimal = {
	feedAddr: string
	feedDec: number
}

export type AssetWithPriceFeed = {
	assetAddr: string
	assetDec: number
	priceFeed: FeedWithDecimal
}

type GenericToken<T extends IERC20 | StableCoin | WETH9> = T

/// GENERAL
export const getFieldsByValue = (
	obj: Record<string, number>,
	fieldNumbers: BigNumberish[],
): string[] => {
	const numbersArray: number[] = fieldNumbers.map((bn) => BigNumber.from(bn).toNumber())

	return Object.keys(obj).filter((key) => numbersArray.includes(obj[key]))
}

export function logPrtyJSON(obj: unknown, str: string = 'Pretty JSON:') {
	console.log(`${str}\n` + JSON.stringify(obj, null, 2))
}

export function _BNsqrt(value: BigNumber): BigNumber {
	return BigNumber.from(new bn(value.toString()).sqrt().toFixed().split('.')[0])
}

export function bitsToBigNumber(bitPositions: BigNumberish[]): BigNumber {
	if (bitPositions.length > 256) {
		throw new Error('bitsToBigNumber: bitPositions array length must be less than 256')
	}
	let bigNumber = BigNumber.from(0)

	for (const position of bitPositions) {
		if (BigNumber.from(position).gt(255)) {
			throw new Error(
				'bitsToBigNumber: bitPositions array elements must be less than 255, got ' + position,
			)
		}
		bigNumber = bigNumber.or(BigNumber.from(2).pow(position))
	}

	return bigNumber
}

export function convertDecimals(
	amount: BigNumber,
	fromDecimals: number,
	toDecimals: number,
): BigNumber {
	if (fromDecimals === toDecimals) {
		return amount
	} else if (fromDecimals > toDecimals) {
		return amount.div(10n ** BigInt(fromDecimals - toDecimals))
	} else {
		return amount.mul(10n ** BigInt(toDecimals - fromDecimals))
	}
}
export function bigNumberToBits(bigNumber: BigNumber): BigNumberish[] {
	const bitPositions: BigNumberish[] = []
	let currentNumber = bigNumber
	let position = 0

	while (currentNumber.gt(0)) {
		if (currentNumber.and(BigNumber.from(1)).gt(0)) {
			bitPositions.push(position)
		}
		currentNumber = currentNumber.shr(1)
		position++
	}

	return bitPositions
}

export async function getReceipt(tx: Promise<ContractTransaction>): Promise<ContractReceipt> {
	const response = await tx
	const receipt = await response.wait()
	return receipt
}

export function twoPercentLose(amount: BigNumberish): BigNumber {
	return BigNumber.from(amount).mul(98).div(100)
}

export const getEventFromTx = async (
	tx: Promise<ContractTransaction>,
	contract: BaseContract,
	event: string,
): Promise<LogDescription> => {
	const receipt = await getReceipt(tx)

	const eventLog = getEventFromReceipt(contract, receipt, event)
	if (!eventLog) {
		throw new Error(`Event ${event} not found`)
	}
	return eventLog
}

export const getEventsFromTx = async (
	tx: Promise<ContractTransaction>,
	baseContract: BaseContract,
	event: string,
): Promise<LogDescription[]> => {
	const receipt = await getReceipt(tx)
	return getEventsFromReceiptByEventName(baseContract, receipt, event)
}

export const getEventsFromReceiptByEventName = (
	contract: BaseContract,
	receipt: ContractReceipt,
	eventName: string,
): LogDescription[] => {
	const onlyValidLogs: LogDescription[] = []
	receipt.logs.map((log) => {
		try {
			const parsedLog = contract.interface.parseLog(log)
			if (parsedLog.name === eventName && log.address === contract.address) {
				onlyValidLogs.push(parsedLog)
			}
		} catch (e) {}
	})
	return onlyValidLogs
}

export const getEventFromReceipt = (
	contract: BaseContract,
	receipt: ContractReceipt,
	event: string,
) => {
	const myLog = receipt.logs.find((log) => {
		try {
			const parsedLog = contract.interface.parseLog(log)
			if (parsedLog.name === event) {
				return true
			}
		} catch (e) {}
	})
	if (!myLog) {
		return null
	} else {
		return contract.interface.parseLog(myLog)
	}
}

export const getEventsFromReceipt = (
	contractFactory: ContractFactory,
	receipt: ContractReceipt,
) => {
	const onlyValidLogs: LogDescription[] = []
	receipt.logs.map((log) => {
		try {
			const parsedLog = contractFactory.interface.parseLog(log)
			onlyValidLogs.push(parsedLog)
		} catch (e) {}
	})
	return onlyValidLogs
}

function isValidTyping(value: string): value is keyof typeof typings {
	return value in typings
}

// interface types {
// 	[key: string]: { name: string; type: string }[]
// }

const typings = {
	Login: [
		{
			name: 'sessionAddress',
			type: 'address',
		},
	],
	Payload: [
		{
			name: 'url',
			type: 'string',
		},
		{
			name: 'deadline',
			type: 'uint256',
		},
	],
}

export default class EIP712PayloadData implements TypedData {
	types: Record<string, { name: string; type: string }[]> = {
		Payload: typings['Payload'],
	}
	primaryType = 'Payload'
	domain = {
		name: 'UFarm Backend',
		version: '1',
		chainId: 1,
		verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
	} as Record<string, unknown>
	message: {}

	constructor(
		typeName: string,
		payload: {
			url: string
			deadline: number
		},
		message: Record<string, unknown>,
		domain?: Record<string, unknown>,
	) {
		if (!isValidTyping(typeName)) throw new Error('Invalid typing')
		this.primaryType = typeName

		this.types = {
			...this.types,
			...{
				[typeName]: { ...typings[typeName].concat({ name: 'payload', type: 'Payload' }) },
			},
		}

		this.message = {
			...message,
			payload: payload,
		}

		if (domain) {
			this.domain = domain
		}
	}
}

/**
 * Does not checks for anything, just encodes data for uniV3 swap.
 * @param tokenFees - array of token addresses and fees [token0, fee0-1, token1, fee1-2, token2 ...]
 * @returns string - encoded path
 */
export function uniV3_tokensFeesToPath(tokenFees: (number | string)[]) {
	let path = '0x'
	for (let i = 0; i < tokenFees.length; i++) {
		const value = tokenFees[i].toString()

		if ((i + 1) % 2 === 0) {
			path += ethers.utils.solidityPack(['uint24'], [value]).split('0x')[1]
		} else {
			path += ethers.utils.solidityPack(['address'], [value]).split('0x')[1]
		}
	}
	return path
}

export type MintableToken = StableCoin | WETH9 | WstETH | Lido | MockedWETH9
export type RawToken = 'StableCoin' | 'WETH9' | 'WstETH' | 'Lido' | 'MockedWETH9'

function isWETH9(obj: any): obj is WETH9 {
	return obj.deposit !== undefined
}
function isWstETH(obj: any): obj is WstETH {
	return obj.getStETHByWstETH !== undefined
}
function isStableCoin(obj: any): obj is StableCoin {
	return obj.mint !== undefined
}
function isStETH(obj: any): obj is Lido {
	return obj.submit !== undefined
}
function isMockedWETH9(obj: any): obj is MockedWETH9 {
	return obj.burnWeth !== undefined
}

export async function mintTokens(
	token: MintableToken,
	amount: BigNumberish,
	wallet: SignerWithAddress,
) {
	// console.log('Minting token ' + (await token.symbol()) + ' with amount ' + amount)
	const connectedToken = token.connect(wallet)
	const valueToSend = BigNumber.from(amount).div(constants.ONE).add(1)
	if (isMockedWETH9(connectedToken)) {
		// console.log(`Minting ${valueToSend} WETHMocked to get ${amount} WETH`)
		return await connectedToken.deposit({
			value: valueToSend,
		})
	} else if (isWETH9(connectedToken)) {
		// console.log('Minting WETH')
		return await connectedToken.deposit({
			value: amount,
		})
	} else if (isStETH(connectedToken)) {
		// console.log('Minting stETH')
		return await connectedToken.submit(ethers.constants.AddressZero, {
			value: amount,
		})
	} else if (isWstETH(connectedToken)) {
		// console.log('Minting wstETH')
		const steth_addr = await connectedToken.stETH()
		const steth_instance = await ethers.getContractAt('Lido', steth_addr, wallet)
		await (
			await steth_instance.connect(wallet).submit(ethers.constants.AddressZero, {
				value: amount,
			})
		).wait()
		await (await steth_instance.connect(wallet).approve(connectedToken.address, amount)).wait()
		return await connectedToken.wrap(amount)
	} else if (isStableCoin(token)) {
		return await connectedToken.mint(wallet.address, amount)
	} else {
		throw new Error('Token is not recognized')
	}
}

const ONE_PRECISION = BigNumber.from(1000000)

export async function setExchangeRate(
	tokenA: MintableToken,
	tokenB: MintableToken,
	desiredExchangeRate: BigNumber,
	signer: SignerWithAddress,
	univ2_factory: UniswapV2Factory,
) {
	console.log('Setting exchange rate:')
	console.log(
		`Token A: ${await tokenA.symbol()}`,
		`Token B: ${await tokenB.symbol()}`,
		`Desired rate: ${desiredExchangeRate.toString()}`,
	)
	const pairAddress = await univ2_factory.getPair(tokenA.address, tokenB.address)
	const pair = await ethers.getContractAt('UniswapV2Pair', pairAddress, signer)

	const [token0, token1] = await Promise.all([pair.token0(), pair.token1()])

	// Determine order of tokens to match the pair
	const reversed = token0 !== tokenA.address
	const [tokenA_instance, tokenB_instance] = reversed
		? [tokenB.connect(signer), tokenA.connect(signer)]
		: [tokenA.connect(signer), tokenB.connect(signer)]

	const [decimalsA, decimalsB] = await Promise.all([
		tokenA_instance.decimals(),
		tokenB_instance.decimals(),
	])
	const [tokenA_reserve, tokenB_reserve] = await pair.getReserves()

	const initialRate = tokenA_reserve.mul(BigNumber.from(10).pow(decimalsB)).div(tokenB_reserve)

	if (desiredExchangeRate.gt(initialRate)) {
		const [bestDeltaX, bestAmountOut] = findAmountInForDesiredImpact(
			tokenA_reserve,
			tokenB_reserve,
			desiredExchangeRate,
			BigNumber.from(10).pow(decimalsB),
		)

		await (await mintTokens(tokenA_instance, bestDeltaX, signer)).wait()
		await (await tokenA_instance.transfer(pair.address, bestDeltaX)).wait()
		const swapTx = await (
			await pair.swap(
				reversed ? 0 : bestAmountOut.mul(99).div(100),
				reversed ? bestAmountOut.mul(99).div(100) : 0,

				signer.address,
				'0x',
			)
		).wait()
	} else {
		const [bestDeltaX, bestAmountOut] = findAmountInForDesiredImpact(
			tokenB_reserve,
			tokenA_reserve,
			BigNumber.from(10)
				.pow(decimalsB)
				.div(desiredExchangeRate)
				.mul(BigNumber.from(10).pow(decimalsA)),
			BigNumber.from(10).pow(decimalsA),
		)

		await (await mintTokens(tokenB_instance, bestDeltaX, signer)).wait()
		await (await tokenB_instance.transfer(pair.address, bestDeltaX)).wait()
		const swapTx = await (
			await pair.swap(
				reversed ? bestAmountOut.mul(99).div(100) : 0,
				reversed ? 0 : bestAmountOut.mul(99).div(100),

				signer.address,
				'0x',
			)
		).wait()
	}
}

function calculateDeltaY(
	x: BigNumber,
	y: BigNumber,
	deltaX: BigNumber,
	precision: BigNumber,
): [BigNumber, BigNumber] {
	const feePercentage = BigNumber.from(3) // 0.3 fee percentage
	const fee = deltaX.mul(feePercentage).div(BigNumber.from(1000)) // Calculate the fee amount

	const yPrime = y.mul(x).mul(precision).div(x.add(deltaX).mul(precision))
	const deltaY = y.sub(yPrime)
	const priceBefore = x.mul(precision).div(y)
	const priceAfter = x.add(deltaX.sub(fee)).mul(precision).div(yPrime)

	return [deltaY, priceAfter]
}

function findAmountInForDesiredImpact(
	x: BigNumber,
	y: BigNumber,
	targetPrice: BigNumber,
	yPrecision: BigNumber,
	precision: BigNumber = targetPrice.div(yPrecision),
): [BigNumber, BigNumber] {
	let low = BigNumber.from(0)
	let high = x.mul(2) // Arbitrarily high, can be adjusted based on expected ranges
	let bestDeltaX = BigNumber.from(0)
	let bestAmountOut = BigNumber.from(0)
	let oldPrice = BigNumber.from(0)

	while (low.lte(high)) {
		const deltaX = low.add(high).div(2)
		const oldAmountOut = bestAmountOut
		const [amountOut, priceAfter] = calculateDeltaY(x, y, deltaX, yPrecision)
		bestAmountOut = amountOut
		bestDeltaX = deltaX

		if (
			priceAfter.sub(targetPrice).abs().lte(precision) ||
			oldAmountOut.eq(amountOut) ||
			oldPrice.eq(priceAfter)
		) {
			break
		} else if (priceAfter.lt(targetPrice)) {
			low = deltaX.add(1)
		} else {
			high = deltaX.sub(1)
		}
		oldPrice = priceAfter
	}

	return [bestDeltaX, bestAmountOut]
}

export async function addLiquidityUniswapV3(
	asset: MintableToken,
	weth: MintableToken,
	assetAmount: BigNumberish,
	wethLiqAmount: BigNumberish,
	uniswapV3Factory: UniswapV3Factory,
	positionManager: NonfungiblePositionManager,
	wallet: SignerWithAddress,
	fee: number = 500,
): Promise<void> {
	const isWethToken0 = BigNumber.from(weth.address).lt(BigNumber.from(asset.address))

	let assetLiqAmount = assetAmount

	const [token0, token1, amount0Desired, amount1Desired] = isWethToken0
		? [weth.address, asset.address, wethLiqAmount, assetLiqAmount]
		: [asset.address, weth.address, assetLiqAmount, wethLiqAmount]

	const poolAddr = await uniswapV3Factory.getPool(token0, token1, fee)

	if (!wallet.provider) {
		throw new Error('Wallet provider is undefined')
	}

	if ((await wallet.provider.getCode(poolAddr)) === '0x') {
		const sqrtPriceX96 = _BNsqrt(BigNumber.from(amount1Desired).shl(192).div(amount0Desired))

		const createTx = await positionManager
			.connect(wallet)
			.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)
		await createTx.wait()
	}

	const poolAddrReal = await uniswapV3Factory.getPool(token0, token1, fee)

	const [wethBalance, assetBalance] = await Promise.all([
		weth.balanceOf(wallet.address),
		asset.balanceOf(wallet.address),
	])

	if (wethBalance.lt(wethLiqAmount)) {
		await (await mintTokens(weth, wethLiqAmount, wallet)).wait()
	}

	if (assetBalance.lt(assetLiqAmount)) {
		await (await mintTokens(asset, assetLiqAmount, wallet)).wait()
	}

	await safeApprove(weth, positionManager.address, wethLiqAmount, wallet)

	await safeApprove(asset, positionManager.address, assetLiqAmount, wallet)

	const mintParams = {
		token0,
		token1,
		fee: fee,
		tickLower: -887220,
		tickUpper: 887220,
		amount0Desired: amount0Desired,
		amount1Desired: amount1Desired,
		amount0Min: 0,
		amount1Min: 0,
		recipient: wallet.address,
		deadline: Date.now() + 100,
	}

	await (await positionManager.connect(wallet).mint(mintParams)).wait()

	const poolv3_instance = (await ethers.getContractAt(
		'contracts/test/UniswapV3/@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool',
		poolAddrReal,
		wallet,
	)) as IUniswapV3Pool

	await (await poolv3_instance.connect(wallet).increaseObservationCardinalityNext(500)).wait()
}

export async function quoteMaxSlippageSingle(
	quoter: QuoterV2,
	quoteArgs: IQuoterV2.QuoteExactInputSingleParamsStruct,
) {
	const zeroForOne = BigNumber.from(quoteArgs.tokenIn).lt(BigNumber.from(quoteArgs.tokenOut))
	const sqrtPriceLimitX96Max = zeroForOne
		? constants.UniV3.MIN_SQRT_RATIO
		: constants.UniV3.MAX_SQRT_RATIO
	const quote = await quoter.callStatic.quoteExactInputSingle({
		...quoteArgs,
		sqrtPriceLimitX96: sqrtPriceLimitX96Max,
	})
	return quote
}

/**
 * @dev This function is used to prepare 1inch-like UniV2 response
 *
 * @param AggregationRouterV5_addr - 1inch AggregationRouterV5 address
 * @param customAmountIn - amount of tokens that should be swapped
 * @param spread - slippage tolerance, 10000 = 100%, 50 = 0.5%
 * @param customRecipient  - address that will receive tokens (usually pool address)
 * @param customRoute - array of token addresses that should be used for swap [tokenA, tokenB, ...]
 * @param unoV2Controller - UnoswapV2Controller contract instance
 * @returns - object with minReturn and tx fields
 */
export async function oneInchCustomUnoswapTo(
	AggregationRouterV5_addr: string,
	customAmountIn: BigNumberish,
	spread: number,
	customRecipient: string,
	customRoute: string[],
	unoV2Controller: UnoswapV2Controller,
) {
	/**
	 * @dev This function is used to calculate amount of tokens that will be received after swap
	 * @param amountIn - amount of tokens that should be swapped
	 * @param reserveIn - amount of tokenIn in reserve
	 * @param reserveOut - amount of tokensOut in reserve
	 * @returns amountOut - amount of tokens that will be received
	 */
	function getAmountOutReserves(
		amountIn: BigNumber,
		reserveIn: BigNumber,
		reserveOut: BigNumber,
	): BigNumber {
		if (amountIn.isZero()) {
			throw new Error('INSUFFICIENT_INPUT_AMOUNT')
		}
		if (reserveIn.isZero() || reserveOut.isZero()) {
			throw new Error('INSUFFICIENT_LIQUIDITY')
		}

		const amountInWithFee = amountIn.mul(997) // Multiply by 997
		const numerator = amountInWithFee.mul(reserveOut) // Multiply amountInWithFee by reserveOut
		const denominator = reserveIn.mul(1000).add(amountInWithFee) // Multiply reserveIn by 1000 and add amountInWithFee

		const amountOut = numerator.div(denominator) // Divide numerator by denominator

		return amountOut
	}

	const REVERSE_MASK = BigNumber.from(
		'0x8000000000000000000000000000000000000000000000000000000000000000',
	)

	const NUMENATOR = ethers.utils
		.parseUnits('997', 6)
		.mul(BigNumber.from('0x10000000000000000000000000000000000000000'))

	let injectedPairsRoute: String[] = []

	if (customRoute.length < 2) {
		throw new Error('Custom route must be at least 2')
	}

	let returnAmount = BigNumber.from(customAmountIn)
	for (let i = 0; i < customRoute.length - 1; i++) {
		let routeString = BigNumber.from('0')

		routeString = routeString.add(NUMENATOR)
		let token0 = customRoute[i]
		let token1 = customRoute[i + 1]

		const reversed = BigNumber.from(token0).gt(BigNumber.from(token1))

		if (reversed) {
			;[token0, token1] = [token1, token0]
		}

		const pairAddr = await unoV2Controller.pairFor(token0, token1)

		const [token0_instance, token1_instance] = [
			ERC20__factory.connect(token0, ethers.provider),
			ERC20__factory.connect(token1, ethers.provider),
		]

		const [reserve0, reserve1] = await Promise.all([
			token0_instance.balanceOf(pairAddr),
			token1_instance.balanceOf(pairAddr),
		])

		if (reversed) {
			returnAmount = getAmountOutReserves(returnAmount, reserve1, reserve0)
			routeString = routeString.add(REVERSE_MASK) // add reversed mask
		} else {
			returnAmount = getAmountOutReserves(returnAmount, reserve0, reserve1)
		}
		routeString = routeString.add(BigNumber.from(pairAddr))

		injectedPairsRoute.push(routeString.toHexString())
	}

	const minReturn = returnAmount.mul(10000 - spread).div(10000) // calculate minReturn with spread

	const unoswapToSelector = '0xf78dc253' // unoswapTo() function selector of AggregationRouterV5

	const data =
		unoswapToSelector +
		ethers.utils.defaultAbiCoder
			.encode(
				['address', 'address', 'uint256', 'uint256', 'uint256[]'],
				[customRecipient, customRoute[0], customAmountIn, minReturn, injectedPairsRoute],
			)
			.slice(2) // remove 0x

	return {
		toAmount: minReturn,
		tx: {
			to: AggregationRouterV5_addr,
			data: data,
		},
	}
}
/**
 * @dev This function is used to prepare 1inch-like UniV2 response
 *
 * @param AggregationRouterV5_addr - 1inch AggregationRouterV5 address
 * @param customAmountIn - amount of tokens that should be swapped
 * @param spread - slippage tolerance, 10000 = 100%, 50 = 0.5%
 * @param customRecipient  - address that will receive tokens (usually pool address)
 * @param customRoute - array of token addresses that should be used for swap [tokenA, tokenB, ...]
 * @param unoV2Controller - UnoswapV2Controller contract instance
 * @returns - object with minReturn and tx fields
 */
export async function oneInchCustomUnoswap(
	AggregationRouterV5_addr: string,
	customAmountIn: BigNumberish,
	spread: number,
	customRecipient: string,
	customRoute: string[],
	unoV2Controller: UnoswapV2Controller,
) {
	/**
	 * @dev This function is used to calculate amount of tokens that will be received after swap
	 * @param amountIn - amount of tokens that should be swapped
	 * @param reserveIn - amount of tokenIn in reserve
	 * @param reserveOut - amount of tokensOut in reserve
	 * @returns amountOut - amount of tokens that will be received
	 */
	function getAmountOutReserves(
		amountIn: BigNumber,
		reserveIn: BigNumber,
		reserveOut: BigNumber,
	): BigNumber {
		if (amountIn.isZero()) {
			throw new Error('INSUFFICIENT_INPUT_AMOUNT')
		}
		if (reserveIn.isZero() || reserveOut.isZero()) {
			throw new Error('INSUFFICIENT_LIQUIDITY')
		}

		const amountInWithFee = amountIn.mul(997) // Multiply by 997
		const numerator = amountInWithFee.mul(reserveOut) // Multiply amountInWithFee by reserveOut
		const denominator = reserveIn.mul(1000).add(amountInWithFee) // Multiply reserveIn by 1000 and add amountInWithFee

		const amountOut = numerator.div(denominator) // Divide numerator by denominator

		return amountOut
	}

	const REVERSE_MASK = BigNumber.from(
		'0x8000000000000000000000000000000000000000000000000000000000000000',
	)

	const NUMENATOR = ethers.utils
		.parseUnits('997', 6)
		.mul(BigNumber.from('0x10000000000000000000000000000000000000000'))

	let injectedPairsRoute: String[] = []

	if (customRoute.length < 2) {
		throw new Error('Custom route must be at least 2')
	}

	let returnAmount = BigNumber.from(customAmountIn)
	for (let i = 0; i < customRoute.length - 1; i++) {
		let routeString = BigNumber.from('0')

		routeString = routeString.add(NUMENATOR)
		let token0 = customRoute[i]
		let token1 = customRoute[i + 1]

		const reversed = BigNumber.from(token0).gt(BigNumber.from(token1))

		if (reversed) {
			;[token0, token1] = [token1, token0]
		}

		const pairAddr = await unoV2Controller.pairFor(token0, token1)

		const [token0_instance, token1_instance] = [
			ERC20__factory.connect(token0, ethers.provider),
			ERC20__factory.connect(token1, ethers.provider),
		]

		const [reserve0, reserve1] = await Promise.all([
			token0_instance.balanceOf(pairAddr),
			token1_instance.balanceOf(pairAddr),
		])

		if (reversed) {
			returnAmount = getAmountOutReserves(returnAmount, reserve1, reserve0)
			routeString = routeString.add(REVERSE_MASK) // add reversed mask
		} else {
			returnAmount = getAmountOutReserves(returnAmount, reserve0, reserve1)
		}
		routeString = routeString.add(BigNumber.from(pairAddr))

		injectedPairsRoute.push(routeString.toHexString())
	}

	const minReturn = returnAmount.mul(10000 - spread).div(10000) // calculate minReturn with spread

	const aggregatorV5_factory = await hre.ethers.getContractFactory('AggregationRouterV5')
	const aggregatorV5 = aggregatorV5_factory.attach(AggregationRouterV5_addr)
	const data = aggregatorV5.interface.encodeFunctionData('unoswap', [
		customRoute[0],
		customAmountIn,
		minReturn,
		injectedPairsRoute.map((x) => BigNumber.from(x)),
	])

	return {
		toAmount: minReturn,
		tx: {
			to: AggregationRouterV5_addr,
			data: data,
		},
	}
}

async function impersonateAndReturnSigner(address: string) {
	await hre.network.provider.request({
		method: 'hardhat_impersonateAccount',
		params: [address],
	})
	return await ethers.getSigner(address)
}
/// 1inch

export interface ISwapRequest {
	srcAsset: string
	dstAsset: string
	srcAmount: string
	fromAddress: string
	toAddress: string
	chainId?: number
}

export interface ISwapResponse {
	toAmount: string
	tx: {
		from: string
		to: string
		data: string
		value: BigNumberish
	}
}
export const getOneInchSwapTransaction = async ({
	srcAsset,
	dstAsset,
	srcAmount,
	fromAddress,
	toAddress,
	chainId = 1,
}: ISwapRequest): Promise<ISwapResponse> => {
	const protocols = ['UNISWAP_V2']

	const apiUrl =
		`https://api.1inch.io/v5.2/${chainId}` +
		`/swap?fromTokenAddress=${srcAsset}` +
		`&toTokenAddress=${dstAsset}` +
		`&amount=${srcAmount.toString()}` +
		`&fromAddress=${fromAddress}` +
		`&destReceiver=${toAddress}` +
		`&&slippage=1` +
		// `&referrerAddress=&slippage=1` +
		`&disableEstimate=true` +
		`&protocols=${protocols.join(',')}`
	const response = await fetch(apiUrl)

	const data = await response.json()
	return {
		toAmount: data.toAmount as string,
		tx: {
			...data.tx,
		},
	} as ISwapResponse
}

export async function mintAndCreatePairUniV2WithEth(
	token: MintableToken,
	amountA: BigNumberish,
	amountETH: BigNumberish,
	signer: SignerWithAddress,
	router: UniswapV2Router02,
) {
	const weth_addr = await router.WETH()
	const weth9Abi = WETH9__factory.abi
	const weth = new ethers.Contract(weth_addr, weth9Abi, signer) as WETH9
	const tokenA = token.connect(signer)

	await (await mintTokens(token, amountA, signer)).wait()

	const depositTx = await weth.deposit({
		value: amountETH,
	})
	await depositTx.wait()

	await safeApprove(tokenA, router.address, amountA, signer)

	await safeApprove(weth, router.address, amountETH, signer)

	const addLiqTx = await router
		.connect(signer)
		.addLiquidity(
			tokenA.address,
			weth_addr,
			amountA,
			amountETH,
			amountA,
			amountETH,
			signer.address,
			(await getBlockchainTimestamp(ethers.provider)) + 100000,
		)
	await addLiqTx.wait()
}
export async function getBlockchainTimestamp(provider: JsonRpcProvider) {
	const latestBlock = await provider.getBlock(await provider.getBlockNumber())
	return latestBlock.timestamp
}

export async function safeApprove(
	tokenContract: GenericToken<IERC20>,
	spender: string,
	amount: BigNumberish,
	signer: SignerWithAddress | Signer,
): Promise<void> {
	const signerAddr = await signer.getAddress()
	const currentAllowance = await tokenContract.allowance(signerAddr, spender)

	if (currentAllowance.lt(amount)) {
		const resetTx = await tokenContract.connect(signer).approve(spender, 0)
		await resetTx.wait()
		const approveTx = await tokenContract.connect(signer).approve(spender, amount)
		await approveTx.wait()
	}
}

export async function mintAndCreatePairUniV2(
	tokenA: MintableToken,
	tokenB: MintableToken,
	amountA: BigNumberish,
	amountB: BigNumberish,
	signer: SignerWithAddress,
	router: UniswapV2Router02,
) {
	await (await mintTokens(tokenA, amountA, signer)).wait()
	await safeApprove(tokenA, router.address, amountA, signer)

	await (await mintTokens(tokenB, amountB, signer)).wait()
	await safeApprove(tokenB, router.address, amountB, signer)

	const [tokenA_balance, tokenB_balance] = await Promise.all([
		tokenA.balanceOf(signer.address),
		tokenB.balanceOf(signer.address),
	])

	await router
		.connect(signer)
		.addLiquidity(
			tokenA.address,
			tokenB.address,
			amountA,
			amountB,
			amountA,
			amountB,
			signer.address,
			(await getBlockchainTimestamp(ethers.provider)) + 30,
		)
}

/// ASSETS
export function tokenToPriceFeedStruct<T extends IChainlinkAggregator>(
	tokenAddr: string,
	tokenDecimals: number,
	priceFeed: T,
	priceFeedDecimals: number,
) {
	return {
		assetAddr: tokenAddr,
		assetDec: tokenDecimals,
		priceFeed: {
			feedAddr: priceFeed.address,
			feedDec: priceFeedDecimals,
		},
	}
}

export function formatUsdt(value: BigNumberish): string {
	value = BigNumber.from(value)
	if (value.isZero()) {
		return '$0'
	}
	const decimals = BigNumber.from(10).pow(6)
	let integerPart = value.div(decimals).toString()
	let decimalPart = value.mod(decimals).toString()
	if (decimalPart.length < 6) {
		decimalPart = decimalPart.padStart(6, '0')
	}
	const formattedValue = `${integerPart}.${decimalPart}`
	return `$${formattedValue}`
}

/// UFARM
/**
 * @dev Converts protocol name to bytes32 representation
 * @param protocol - protocol name, for example 'UNISWAP_V2'
 * @returns - bytes32 representation of protocol name
 */
export const protocolToBytes32 = (protocol: string) => {
	return ethers.utils.solidityKeccak256(['string'], [protocol])
}

export type PoolAndAdmin = {
	pool: UFarmPool
	admin: PoolAdmin
}

/**
 * @dev Deploys UFarmPool contract from UFarmFund contract
 * @param newPoolArgs - pool creation settings
 * @param fundWithManager - fund contract with manager connected [fund.connect(fundManager)]
 * @param callStatic - if true, function will be called without sending transaction. Usefull to check if pool can be created
 * @returns - UFarmPool contract
 */
export async function deployPool(
	newPoolArgs: IUFarmPool.CreationSettingsStruct,
	fundWithManager: UFarmFund,
	callStatic?: boolean,
): Promise<PoolAndAdmin> {
	const randomSalt = () => {
		return ethers.utils.randomBytes(32)
	}
	if (!callStatic) {
		const createPoolTx = await fundWithManager.createPool(newPoolArgs, randomSalt())
		const receipt = await createPoolTx.wait()
		// parse pool address from event
		const signer = fundWithManager.signer
		
		const poolAddress = receipt.events?.find((x) => x.event === 'PoolCreated')?.args?.pool as string

		const poolAdminAddr = receipt.events?.find((x) => x.event === 'PoolCreated')?.args
			?.poolAdmin as string
		return {
			pool: await ethers.getContractAt('UFarmPool', poolAddress, signer),
			admin: await ethers.getContractAt('PoolAdmin', poolAdminAddr, signer),
		}
	} else {
		// return (await fundWithManager.callStatic.createPool(newPoolArgs)) as unknown as UFarmPool
		const [poolAddr, poolAdminAddr] = await fundWithManager.callStatic.createPool(
			newPoolArgs,
			randomSalt(),
		)
		return {
			pool: await ethers.getContractAt('UFarmPool', poolAddr, fundWithManager.signer),
			admin: await ethers.getContractAt('PoolAdmin', poolAdminAddr, fundWithManager.signer),
		}
	}
}

export const nullClientVerification = () => {
	return {
		signature: "0x",
		validTill: 0,
		tier: 0
	}
}

/**
 * @dev Mints and deposits tokens to pool
 * @dev for testing purposes only
 * @param pool
 * @param mintableToken
 * @param signer
 * @param amount
 * @returns - deposit transaction
 */
export async function mintAndDeposit(
	pool: UFarmPool,
	mintableToken: MintableToken,
	signer: SignerWithAddress,
	amount: BigNumberish,
) {
	// ;(await mintableToken.connect(signer).mint(signer.address, amount)).wait()
	await mintTokens(mintableToken, amount, signer)
	await safeApprove(mintableToken, pool.address, amount, signer)
	return await pool.connect(signer).deposit(amount, nullClientVerification())
}

function encodeSwapData(
	amountIn: BigNumber,
	amountOutMin: BigNumber,
	deadline: BigNumberish,
	path: string[],
) {
	return ethers.utils.defaultAbiCoder.encode(
		['uint256', 'uint256', 'uint256', 'address[]'],
		Array.from([amountIn, amountOutMin, deadline, path]),
	)
}

/**
 * @dev This function is used to encode data for delegateSwapExactTokensForTokens() controller function
 * @param amountIn - amount of tokens that should be swapped
 * @param amountOutMin - minimum amount of tokens that should be received
 * @param deadline - deadline, TX will fail if it is not mined before deadline
 * @param path - path of tokens that should be used for swap [tokenA, tokenB, ...]
 * @returns - encoded data for delegateSwapExactTokensForTokens() function, use it as argument in Pool swap function
 */
export function encodePoolSwapDataUniswapV2(
	amountIn: BigNumber,
	amountOutMin: BigNumber,
	deadline: BigNumberish,
	path: string[],
) {
	const controllerInterface = new Interface(UnoswapV2ControllerABI)
	return controllerInterface.encodeFunctionData('delegateSwapExactTokensForTokens', [
		encodeSwapData(amountIn, amountOutMin, deadline, path),
	])
}

function encodeAddLiquidityDataGasSaving(
	tokenA: string,
	tokenB: string,
	amountADesired: BigNumberish,
	amountBDesired: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
) {
	const reversed = BigNumber.from(tokenA).gt(tokenB)
	return ethers.utils.defaultAbiCoder.encode(
		['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
		Array.from([
			reversed ? tokenB : tokenA,
			reversed ? tokenA : tokenB,
			reversed ? amountBDesired : amountADesired,
			reversed ? amountADesired : amountBDesired,
			reversed ? amountBMin : amountAMin,
			reversed ? amountAMin : amountBMin,
			deadline,
		]),
	)
}
/**
 * @dev This function is used to encode data for delegateAddLiquidity function, but it may reverse tokens order to save gas
 * @param tokenA - first token that should be used for liquidity
 * @param tokenB - second token that should be used for liquidity
 * @param amountADesired - amount of first token that should be used for providing liquidity
 * @param amountBDesired - amount of second token that should be used for providing liquidity
 * @param amountAMin - minimum amount of first token that should be used for providing liquidity
 * @param amountBMin - minimum amount of second token that should be used for providing liquidity
 * @param deadline - deadline, TX will fail if it is not mined before deadline
 * @returns
 */
export function encodePoolAddLiqudityDataUniswapV2(
	tokenA: string,
	tokenB: string,
	amountADesired: BigNumberish,
	amountBDesired: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
) {
	const controllerInterface = new Interface(UnoswapV2ControllerABI)
	return controllerInterface.encodeFunctionData('delegatedAddLiquidity', [
		encodeAddLiquidityDataGasSaving(
			tokenA,
			tokenB,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin,
			deadline,
		),
	])
}

function encodeAddLiquidityData(
	tokenA: string,
	tokenB: string,
	amountADesired: BigNumberish,
	amountBDesired: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
) {
	return ethers.utils.defaultAbiCoder.encode(
		['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
		Array.from([tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, deadline]),
	)
}

/**
 * @dev This function is used to encode data for delegateAddLiquidity function, but it does not reverse tokens order
 * @param tokenA - first token that should be used for liquidity
 * @param tokenB - second token that should be used for liquidity
 * @param amountADesired - amount of first token that should be used for providing liquidity
 * @param amountBDesired - amount of second token that should be used for providing liquidity
 * @param amountAMin - minimum amount of first token that should be used for providing liquidity
 * @param amountBMin - minimum amount of second token that should be used for providing liquidity
 * @param deadline - deadline, TX will fail if it is not mined before deadline
 * @returns - encoded data for delegateAddLiquidity function, use it as argument in Pool swap function
 */
export function encodePoolAddLiqudityDataAsIsUniswapV2(
	tokenA: string,
	tokenB: string,
	amountADesired: BigNumberish,
	amountBDesired: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
): string {
	const controllerInterface = new Interface(UnoswapV2ControllerABI)
	return controllerInterface.encodeFunctionData('delegatedAddLiquidity', [
		encodeAddLiquidityData(
			tokenA,
			tokenB,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin,
			deadline,
		),
	])
}

function encodeRemoveLiquidity(
	tokenA: string,
	tokenB: string,
	liquidity: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
): string {
	return ethers.utils.defaultAbiCoder.encode(
		['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
		[tokenA, tokenB, liquidity, amountAMin, amountBMin, deadline],
	)
}

function encodeRemoveLiquidityGasSavingUniswapV2(
	tokenA: string,
	tokenB: string,
	liquidity: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
): string {
	const reversed = BigNumber.from(tokenA) > BigNumber.from(tokenB)
	const [token0, token1, amount0, amount1] = reversed
		? [tokenB, tokenA, amountBMin, amountAMin]
		: [tokenA, tokenB, amountAMin, amountBMin]
	return ethers.utils.defaultAbiCoder.encode(
		['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
		[token0, token1, liquidity, amount0, amount1, deadline],
	)
}

/**
 * @dev This function is used to encode data for delegateRemoveLiquidity function, but it may reverse tokens order to save gas
 * @param tokenA - first token that should be used for liquidity
 * @param tokenB - second token that should be used for liquidity
 * @param liquidity - amount of liquidity that should be removed
 * @param amountAMin - minimum amount of first token that should be received
 * @param amountBMin - minimum amount of second token that should be received
 * @param deadline - deadline, TX will fail if it is not mined before deadline
 * @returns - encoded data for delegateRemoveLiquidity function, use it as argument in Pool swap function
 * @notice - this function may reverse tokens order to save gas
 * @notice - this function does not check if tokens are in pool
 * @notice - this function does not check if pool has enough liquidity
 */
export function encodePoolRemoveLiquidityUniswapV2(
	tokenA: string,
	tokenB: string,
	liquidity: BigNumberish,
	amountAMin: BigNumberish,
	amountBMin: BigNumberish,
	deadline: BigNumberish,
): string {
	const controllerInterface = new Interface(UnoswapV2ControllerABI)
	return controllerInterface.encodeFunctionData('delegatedRemoveLiquidity', [
		encodeRemoveLiquidityGasSavingUniswapV2(
			tokenA,
			tokenB,
			liquidity,
			amountAMin,
			amountBMin,
			deadline,
		),
	])
}

/**
 * @dev Encoder for 1inch swap
 * @param oneInchResponseTxData - data from 1inch response
 * @returns - encoded data for delegate1InchSwap function, use it as argument in UFarmPool.protocolAction() function
 */
export function encodePoolOneInchSwap(oneInchResponseTxData: string) {
	const oneInchControllerInterface = new Interface(
		OneInchV5ControllerABI,
	) as OneInchV5ControllerInterface
	return oneInchControllerInterface.encodeFunctionData('delegated1InchSwap', [
		oneInchResponseTxData,
	])
}

/**
 * @dev Encoder for 1inch multi swap
 * @param oneInchResponseTxDataArray - array of tx calls from 1inch response
 * @returns - encoded data for delegate1InchMultiSwap function, use it as argument in UFarmPool.protocolAction() function
 */
export function encodePoolOneInchMultiSwap(oneInchResponseTxDataArray: string[]) {
	const oneInchControllerInterface = new Interface(
		OneInchV5ControllerABI,
	) as OneInchV5ControllerInterface
	return oneInchControllerInterface.encodeFunctionData('delegated1InchMultiSwap', [
		oneInchResponseTxDataArray,
	])
}

export function encodePoolSwapUniV3SingleHopExactInput(
	tokenIn: string,
	tokenOut: string,
	fee: BigNumberish,
	recipient: string,
	deadline: BigNumberish,
	amountIn: BigNumberish,
	amountOutMinimum: BigNumberish,
	sqrtPriceLimitX96: BigNumberish,
) {
	const controllerInterface = new Interface(UnoswapV3ControllerABI) as UnoswapV3ControllerInterface

	const encodedData = ethers.utils.defaultAbiCoder.encode(
		['address', 'address', 'uint24', 'address', 'uint256', 'uint256', ' uint256', 'uint160'],
		[tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96],
	)
	return controllerInterface.encodeFunctionData('delegatedSwapExactInputSingleHop', [encodedData])
}

/**
 * Encodes data for a multi-hop exact input swap in a Uniswap V3 pool.
 *
 * @param tokenFeeTokenPath An array representing the path of tokens to swap through with fees.
 * @param recipient         The address of the recipient who will receive the swapped tokens.
 * @param deadline          The deadline by which the swap must be executed, specified as a Unix timestamp.
 * @param amountIn          The amount of the input token to be swapped.
 * @param amountOutMinimum  The minimum amount of the output token that the swap should provide.
 * @return                  The encoded function data as a string, which can be included in a transaction
 *                          to perform the multi-hop swap in a Uniswap V3 pool.
 * @example
 * const tokenFeeTokenPath = [tokens.USDT.address, 500, tokens.WETH.address, 500, tokens.DAI.address] // Example token path
 * const recipient = '0xRecipientAddress'; // Example recipient address
 * const deadline = 1642636800; // Example deadline (Unix timestamp)
 * const amountIn = ethers.utils.parseUnits('100', 18); // Example amount of input token
 * const amountOutMinimum = ethers.utils.parseUnits('500', 18); // Example minimum output amount
 *
 * const encodedData = encodePoolSwapUniV3MultiHopExactInput(
 *   tokenFeeTokenPath,
 *   recipient,
 *   deadline,
 *   amountIn,
 *   amountOutMinimum
 * );
 */
export function encodePoolSwapUniV3MultiHopExactInput(
	tokenFeeTokenPath: (number | string)[],
	recipient: string,
	deadline: BigNumberish,
	amountIn: BigNumberish,
	amountOutMinimum: BigNumberish,
) {
	const controllerInterface = new Interface(UnoswapV3ControllerABI) as UnoswapV3ControllerInterface

	const path = uniV3_tokensFeesToPath(tokenFeeTokenPath)

	const encodedData = ethers.utils.defaultAbiCoder.encode(
		['address', 'uint256', 'uint256', 'uint256', 'bytes'],
		[recipient, deadline, amountIn, amountOutMinimum, path],
	)

	return controllerInterface.encodeFunctionData('delegatedSwapExactInputMultiHop', [encodedData])
}

export function encodePoolMintPositionUniV3(
	mintV3Params: INonfungiblePositionManager.MintParamsStruct,
) {
	const controllerInterface = new Interface(UnoswapV3ControllerABI) as UnoswapV3ControllerInterface

	const encodedData = ethers.utils.defaultAbiCoder.encode(
		[
			'address',
			'address',
			'uint24',
			'int24',
			'int24',
			'uint256',
			'uint256',
			'uint256',
			'uint256',
			'address',
			'uint256',
		],
		[
			mintV3Params.token0,
			mintV3Params.token1,
			mintV3Params.fee,
			mintV3Params.tickLower,
			mintV3Params.tickUpper,
			mintV3Params.amount0Desired,
			mintV3Params.amount1Desired,
			mintV3Params.amount0Min,
			mintV3Params.amount1Min,
			mintV3Params.recipient,
			mintV3Params.deadline,
		],
	)

	return controllerInterface.encodeFunctionData('delegateMintNewPosition', [encodedData])
}

export function encodeBurnPositionUniV3(
	burnV3Params: INonfungiblePositionManager.DecreaseLiquidityParamsStruct,
) {
	const controllerInterface = new Interface(UnoswapV3ControllerABI) as UnoswapV3ControllerInterface

	const encodedData = ethers.utils.defaultAbiCoder.encode(
		['uint256', 'uint128', 'uint256', 'uint256', 'uint256'],
		[
			burnV3Params.tokenId,
			burnV3Params.liquidity,
			burnV3Params.amount0Min,
			burnV3Params.amount1Min,
			burnV3Params.deadline,
		],
	)

	return controllerInterface.encodeFunctionData('delegateBurnPosition', [encodedData])
}

export function encodeCollectFeesUniV3(
	collectV3Params: INonfungiblePositionManager.CollectParamsStruct,
) {
	const controllerInterface = new Interface(UnoswapV3ControllerABI) as UnoswapV3ControllerInterface

	const encodedData = ethers.utils.defaultAbiCoder.encode(
		['uint256', 'address', 'uint128', 'uint128'],
		[
			collectV3Params.tokenId,
			collectV3Params.recipient,
			collectV3Params.amount0Max,
			collectV3Params.amount1Max,
		],
	)

	return controllerInterface.encodeFunctionData('delegatedCollectAllFees', [encodedData])
}

export type WithdrawRequestStruct = {
	sharesToBurn: BigNumberish
	minOutputAmount: BigNumberish
	salt: string
	poolAddr: string
}

export type SignedWithdrawRequestStruct = {
	body: WithdrawRequestStruct
	signature: string
}

export async function prepareWithdrawRequest(
	user: SignerWithAddress,
	pool: UFarmPool,
	sharesToBurn: BigNumberish,
) {
	// Sign the withdraw request
	const signedWithdrawalRequest = await _signWithdrawRequest(pool, user, {
		sharesToBurn: sharesToBurn,
		minOutputAmount: 0,
		salt: ethers.utils.solidityKeccak256(['string'], [Date.now().toString()]),
		poolAddr: pool.address,
	} as WithdrawRequestStruct)

	// Prepare the withdraw argument
	const withdrawArgument = {
		body: signedWithdrawalRequest.msg,
		signature: signedWithdrawalRequest.sig,
	}

	return withdrawArgument
}

async function getDomainData(pool_instance: UFarmPool) {
	const [chainId, name, version] = await Promise.all([
		(await pool_instance.provider.getNetwork()).chainId,
		pool_instance.name(),
		pool_instance.version(),
	])
	return {
		name: name,
		version: version,
		chainId: chainId,
		verifyingContract: pool_instance.address,
	}
}

export async function _signWithdrawRequest(
	pool_instance: UFarmPool,
	requester: SignerWithAddress,
	msg = {} as WithdrawRequestStruct,
) {
	const domainData = await getDomainData(pool_instance)

	const domainHash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
					[
						_hashStr(constants.domain_string),
						_hashStr(domainData.name),
						_hashStr(domainData.version),
						domainData.chainId,
						domainData.verifyingContract,
					],
				),
			),
		],
	)

	const withdrawRequest_msg = {
		...msg,
	} as WithdrawRequestStruct

	const withdrawRequest_types = {
		WithdrawRequest: [
			{ name: 'sharesToBurn', type: 'uint256' },
			{ name: 'salt', type: 'bytes32' },
			{ name: 'poolAddr', type: 'address' },
			{ name: 'minOutputAmount', type: 'uint256' },
		],
	}

	const withdrawRequest_string =
		'WithdrawRequest(uint256 sharesToBurn,bytes32 salt,address poolAddr,uint256 minOutputAmount)'

	const withdrawRequest_hash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'uint256', 'bytes32', 'address', 'uint256'],
					[
						_hashStr(withdrawRequest_string),
						withdrawRequest_msg.sharesToBurn,
						withdrawRequest_msg.salt,
						withdrawRequest_msg.poolAddr,
						withdrawRequest_msg.minOutputAmount,
					],
				),
			),
		],
	)
	const eip712MsgHash = _toEIP712MsgHash(domainHash, withdrawRequest_hash)

	const eip712Signature = await requester._signTypedData(domainData, withdrawRequest_types, {
		...withdrawRequest_msg,
		primaryType: 'WithdrawRequest',
	})

	return {
		msg: withdrawRequest_msg,
		sig: eip712Signature,
		hash: eip712MsgHash,
	}
}
export type DepositRequestStruct = {
	amountToInvest: BigNumberish
	minOutputAmount: BigNumberish
	salt: string
	poolAddr: string
	deadline: BigNumberish
	bearerToken: string
}

export type SignedDepositRequestStruct = {
	body: DepositRequestStruct
	sig: string
}

export async function _signDepositRequest(
	pool_instance: UFarmPool,
	requester: SignerWithAddress,
	msg = {} as DepositRequestStruct,
) {
	const domainData = await getDomainData(pool_instance)

	const domainHash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
					[
						_hashStr(constants.domain_string),
						_hashStr(domainData.name),
						_hashStr(domainData.version),
						domainData.chainId,
						domainData.verifyingContract,
					],
				),
			),
		],
	)

	const depositRequest_msg = {
		...msg,
		deadline: BigNumber.from(msg.deadline).isZero()
			? (await getBlockchainTimestamp(ethers.provider)) + time.duration.days(1)
			: msg.deadline,
	} as DepositRequestStruct

	const depositRequest_types = {
		DepositRequest: [
			{ name: 'amountToInvest', type: 'uint256' },
			{ name: 'salt', type: 'bytes32' },
			{ name: 'poolAddr', type: 'address' },
			{ name: 'deadline', type: 'uint96' },
			{ name: 'bearerToken', type: 'address' },
			{ name: 'minOutputAmount', type: 'uint256' },
		],
	}

	const depositRequest_string =
		'DepositRequest(uint256 amountToInvest,bytes32 salt,address poolAddr,uint96 deadline,address bearerToken,uint256 minOutputAmount)'

	const depositRequest_hash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'uint256', 'bytes32', 'address', 'uint96', 'address', 'uint256'],
					[
						_hashStr(depositRequest_string),
						depositRequest_msg.amountToInvest,
						depositRequest_msg.salt,
						depositRequest_msg.poolAddr,
						depositRequest_msg.deadline,
						depositRequest_msg.bearerToken,
						depositRequest_msg.minOutputAmount,
					],
				),
			),
		],
	)
	const eip712MsgHash = _toEIP712MsgHash(domainHash, depositRequest_hash)

	const eip712Signature = await requester._signTypedData(domainData, depositRequest_types, {
		...depositRequest_msg,
		primaryType: 'DepositRequest',
	})

	return {
		msg: depositRequest_msg,
		sig: eip712Signature,
		hash: eip712MsgHash,
	}
}

export type TierVerificationSignature = {
	clientVerification: {
		signature: string
		validTill: BigNumberish
		tier: number
	}
	hash: string
	messageHash: string
}

export async function _signTierVerification(
	pool_instance: UFarmPool,
	verifier: SignerWithAddress,
	investor: string,
	tier: number,
	validTill?: BigNumberish,
): Promise<TierVerificationSignature> {
	const domainData = await getDomainData(pool_instance)

	const domainHash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
					[
						_hashStr(constants.domain_string),
						_hashStr(domainData.name),
						_hashStr(domainData.version),
						domainData.chainId,
						domainData.verifyingContract,
					],
				),
			),
		],
	)

	const resolvedValidTill = BigNumber.from(
		validTill ??
			(BigNumber.from(await getBlockchainTimestamp(ethers.provider)).add(time.duration.hours(1))),
	)

	const tierAsNumber = BigNumber.from(tier).toNumber()
	if (tierAsNumber < 0 || tierAsNumber > 255) {
		throw new Error('Tier must fit into uint8')
	}

	const tierVerificationString =
		'ClientVerification(address investor,uint8 tier,uint128 validTill)'

	const tierVerificationHash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'address', 'uint8', 'uint128'],
					[_hashStr(tierVerificationString), investor, tierAsNumber, resolvedValidTill],
				),
			),
		],
	)

	const eip712MsgHash = _toEIP712MsgHash(domainHash, tierVerificationHash)

	const signature = await verifier._signTypedData(
		domainData,
		{
			ClientVerification: [
				{ name: 'investor', type: 'address' },
				{ name: 'tier', type: 'uint8' },
				{ name: 'validTill', type: 'uint128' },
			],
		},
		{
			investor,
			tier: tierAsNumber,
			validTill: resolvedValidTill,
		},
	)

	return {
		clientVerification: {
			signature,
			validTill: resolvedValidTill,
			tier: tierAsNumber,
		},
		hash: eip712MsgHash,
		messageHash: tierVerificationHash,
	}
}

export async function increasedGasLimitWrapper<T extends { gasLimit?: BigNumberish }>(
	transaction: T,
	provider: JsonRpcProvider,
): Promise<T> {
	try {
		// Estimate gas for the transaction and await the result
		const estimatedGas = await provider.estimateGas(transaction)

		// Increase the gas limit by 15%
		const increasedGasLimit = estimatedGas.mul(115).div(100)

		// Return a new transaction object with the increased gas limit
		return {
			...transaction,
			gasLimit: increasedGasLimit,
		}
	} catch (error) {
		console.error('Error in increasing gas limit:', error)
		throw error
	}
}

export async function logChangeBalanceWrapper<T>(
	func: () => Promise<T>,
	account: string,
	token1?: string,
	token2?: string,
) {
	interface IBalanceLog {
		symbol: string
		balance_before: string
		balance_after: string
	}

	const [token1_instance, token2_instance] = await Promise.all([
		token1 ? IERC20Metadata__factory.connect(token1, ethers.provider) : undefined,
		token2 ? IERC20Metadata__factory.connect(token2, ethers.provider) : undefined,
	])

	const [symbol1, symbol2, decimals1, decimals2] = await Promise.all([
		token1_instance ? token1_instance.symbol() : undefined,
		token2_instance ? token2_instance.symbol() : undefined,
		token1_instance ? token1_instance.decimals() : undefined,
		token2_instance ? token2_instance.decimals() : undefined,
	])

	const [balance1_before, balance2_before] = await Promise.all([
		token1_instance ? token1_instance.balanceOf(account) : undefined,
		token2_instance ? token2_instance.balanceOf(account) : undefined,
	])

	const result = await func()

	const [balance1_after, balance2_after] = await Promise.all([
		token1_instance ? token1_instance.balanceOf(account) : undefined,
		token2_instance ? token2_instance.balanceOf(account) : undefined,
	])

	const log1 = token1
		? ({
				symbol: symbol1,
				balance_before: balance1_before?.toString(),
				balance_after: balance1_after?.toString(),
		  } as IBalanceLog)
		: undefined

	const log2 = token2
		? ({
				symbol: symbol2,
				balance_before: balance2_before?.toString(),
				balance_after: balance2_after?.toString(),
		  } as IBalanceLog)
		: undefined

	if (log1 || log2) {
		console.table([log1, log2].filter((x) => x))
	}

	return result
}

export function _toEIP712MsgHash(domainHash: string, msgHash: string) {
	const packedDigest = ethers.utils.solidityPack(
		['string', 'bytes32', 'bytes32'],
		['\x19\x01', domainHash, msgHash],
	)

	return ethers.utils.solidityKeccak256(['bytes'], [packedDigest])
}

const _hashStr = (str: string) => {
	return ethers.utils.solidityKeccak256(['string'], [str])
}

export async function _prepareInvite(
	fund_inst: UFarmFund,
	inviter: SignerWithAddress,
	msg: {
		invitee: string
		permissionsMask: BigNumber
		deadline?: number
	},
) {
	const deadline = (await getBlockchainTimestamp(ethers.provider)) + time.duration.days(1)

	const [name, version, chainId] = await Promise.all([
		fund_inst.name(),
		fund_inst.version(),
		(await ethers.provider.getNetwork()).chainId,
	])
	const domainData = {
		name: name,
		version: version,
		chainId: chainId,
		verifyingContract: fund_inst.address,
	}

	const domain_string =
		'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

	const domainHash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
					[
						_hashStr(domain_string),
						_hashStr(domainData.name),
						_hashStr(domainData.version),
						domainData.chainId,
						domainData.verifyingContract,
					],
				),
			),
		],
	)

	const invitation_msg = {
		...msg,
		deadline: !msg.deadline ? deadline : msg.deadline,
	}

	const invitation_types = {
		FundMemberInvitation: [
			{ name: 'invitee', type: 'address' },
			{ name: 'permissionsMask', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
		],
	}
	const invitation_string =
		'FundMemberInvitation(address invitee,uint256 permissionsMask,uint256 deadline)'

	const invitation_hash = ethers.utils.solidityKeccak256(
		['bytes'],
		[
			ethers.utils.arrayify(
				ethers.utils.defaultAbiCoder.encode(
					['bytes32', 'address', 'uint256', 'uint256'],
					[
						_hashStr(invitation_string),
						invitation_msg.invitee,
						invitation_msg.permissionsMask,
						invitation_msg.deadline,
					],
				),
			),
		],
	)

	const eip712Signature = await inviter._signTypedData(
		domainData,
		{
			...invitation_types,
		},
		{
			...invitation_msg,
			primaryType: 'FundMemberInvitation',
		},
	)

	const eip712MsgHash = _toEIP712MsgHash(domainHash, invitation_hash)

	return {
		msg: invitation_msg,
		sig: eip712Signature,
		hash: eip712MsgHash,
	}
}

export async function get1InchResult(src: string, dst: string, amount: BigNumberish) {
	const axios = require('axios')
	const url = 'https://api.1inch.dev/swap/v5.2/42161/swap'

	const token = process.env.ONE_INCH_TOKEN || ''
	if (token === '') {
		throw new Error('1inch token is not set')
	}

	const config = {
		headers: {
			Authorization: token,
		},
		params: {
			src: src,
			dst: dst,
			amount: amount,
			from: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
			slippage: '1',
			protocols: 'ARBITRUM_BALANCER_V2',
			includeProtocols: 'true',
			allowPartialFill: 'false',
			disableEstimate: 'true',
			usePermit2: 'false',
			includeTokenInfo: 'true',
			complexityLevel: 0,
			parts: 1,
			mainRouteParts: 1,
		},
	}

	try {
		const response = await axios.get(url, config)
		// console.log(response.data)
		return response.data
	} catch (error) {
		console.error(error)
	}
}

const ZERO = 0
const ONE = ethers.utils.parseEther('1')
const TEN_PERCENTS = ONE.div(10)
const HALF = ONE.div(2)
const MANY_ETHER = ethers.utils.parseEther('10000000000')
const ONE_BUCKS = ethers.utils.parseUnits('1', 6)
const ONE_HUNDRED_ETH = ethers.utils.parseEther('100')
const ONE_HUNDRED_BUCKS = ethers.utils.parseUnits('100', 6)
const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const DAY = 86400 // in seconds
const DAYS = DAY
const WEEK = DAY * 7
const YEAR = DAY * 365

const _MIN_SQRT_RATIO = BigNumber.from(4295128739 + 1)
const _MAX_SQRT_RATIO = BigNumber.from('1461446703485210103287273052203988822378723970342').sub(1)

export const constants = {
	ZERO: ZERO,
	ONE: ethers.utils.parseEther('1'),
	ZERO_POINT_3_PERCENTS: ONE.div(1000).mul(3),
	FIVE_PERCENTS: ONE.div(20),
	TEN_PERCENTS,
	HALF,
	MANY_ETHER,
	ONE_BUCKS,
	ONE_HUNDRED_ETH,
	ONE_HUNDRED_BUCKS,
	NATIVE_ADDRESS,
	domain_string:
		'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
	Date: {
		FIVE_MIN: 300,
		DAY,
		DAYS,
		WEEK,
		MONTH: 30 * DAY,
		YEAR,
	},
	Pool: {
		Commission: {
			MAX_COMMISSION_STEP: 65535,
			MAX_PERFORMANCE_COMMISION: 5000,
			ONE_HUNDRED_PERCENT: 10000,
		},
		State: {
			Draft: 0,
			Created: 1,
			Active: 2,
			Deactivating: 3,
			Terminated: 4,
		},
		Permissions: {
			// Member role
			Member: 0,
			// Pool Editor role
			UpdatePoolDescription: 1,
			UpdatePoolPermissions: 2,
			PoolStatusControl: 3,
			UpdatePoolFees: 4,
			UpdatePoolTopUpAmount: 5,
			UpdateLockupPeriods: 6,
			ManagePool: 7,
			// Pool Finance Manager role
			ApprovePoolTopup: 8,
			ApprovePoolWithdrawals: 9,
			ManagePoolFunds: 10,
		},
		Roles: {
			MemberRole: [0],
			PoolEditorRole: [1, 2, 3, 4, 5, 6],
			PoolFinanceManagerRole: [8, 9, 10],
		},
	},
	Fund: {
		State: {
			Approved: 0,
			Active: 1,
			Terminated: 2,
			Blocked: 3,
		},
		Permissions: {
			// Fund Member role
			Member: 0,
			// Fund Owner role
			Owner: 1,
			// Fund Editor role
			UpdateFund: 2,
			InviteFundMember: 3,
			BlockFundMember: 4,
			UpdateFundPermissions: 5,
			// Pool Creator and Editor role
			CreatePool: 6,
			UpdatePoolDescription: 7,
			UpdatePoolPermissions: 8,
			PoolStatusControl: 9,
			UpdatePoolFees: 10,
			UpdatePoolTopUpAmount: 11,
			UpdateLockupPeriods: 12,
			// Fund Finance Manager role
			ManageFund: 13,
			// All Pools Finance Manager role
			ApprovePoolTopup: 14,
			ApprovePoolWithdrawals: 15,
			ManagePoolFunds: 16,
		},
		Roles: {
			MemberRole: [0],
			OwnerRole: [1],
			FundEditorRole: [2, 3, 4, 5],
			PoolCreatorAndEditorRole: [6, 7, 8, 9, 10, 11, 12],
			FundFinanceManagerRole: [13],
			AllPoolsFinanceManagerRole: [14, 15, 16],
		},
	},
	UFarm: {
		prtocols: {
			UniswapV2ProtocolString: protocolToBytes32('UniswapV2'),
			UniswapV3ProtocolString: protocolToBytes32('UniswapV3'),
			OneInchProtocolString: protocolToBytes32('OneInchV5'),
		},
		Permissions: {
			Member: 0,
			Owner: 1,
			UpdatePermissions: 2,
			UpdateUFarmMember: 3,
			DeleteUFarmMember: 4,
			ApproveFundCreation: 5,
			BlockFund: 6,
			BlockInvestor: 7,
			ManageFees: 8,
			ManageFundDeposit: 9,
			ManageWhitelist: 10,
			ManageAssets: 11,
			TurnPauseOn: 12,
			ManageQuexFeed: 13,
			VerifyClient: 14,
		},
		Roles: {
			MemberRole: [0],
			OwnerRole: [1],
			TeamManagerRole: [2, 3, 4],
			ModeratorRole: [5, 6, 7, 8, 9, 10, 11],
			CrisisManagerRole: [12],
			BackendRole: [5, 14],
		},
	},
	UniV3: {
		MAX_SQRT_RATIO: _MAX_SQRT_RATIO,
		MIN_SQRT_RATIO: _MIN_SQRT_RATIO,
		MIN_TICK: -887272,
		MAX_TICK: 887272,
	},
}

async function manualCheck() {
	const native_address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
	const usdt_address = '0xdac17f958d2ee523a2206206994597c13d831ec7'
	const weth_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
	const uniswapFactory_addr = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
	const uniswapRouter_addr = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
	const eth_oneinch_routerv5_address = '0x1111111254eeb25477b68fb85ed929f73a960582'
	// get account addr from dotenv:
	const my_account = process.env.TEST_ACCOUNT_ADDR as string
	const my_private_key = process.env.TEST_ACCOUNT_PRIVATE_KEY as string
	const another_account = '0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5'

	const my_signer = new ethers.Wallet(my_private_key).connect(ethers.provider)

	console.log(`Signer address: ${my_signer.address}`)

	const another_signer = await impersonateAndReturnSigner(another_account)
	await another_signer.sendTransaction({
		to: my_account,
		value: ethers.utils.parseEther('2'),
	})

	const srcAmount = ethers.utils.parseUnits('100', 6)
	console.log(`srcAmount: ${srcAmount.toString()}`)

	const swapResponse_USDTWETH = await getOneInchSwapTransaction({
		srcAsset: usdt_address,
		dstAsset: weth_address,
		srcAmount: srcAmount.toString(),
		fromAddress: my_account,
		toAddress: another_account,
		chainId: 1,
	})
	logPrtyJSON(swapResponse_USDTWETH, 'Swap response USDTWETH:')

	const oneInchAggrV5_factory = (await ethers.getContractFactory(
		'AggregationRouterV5',
	)) as AggregationRouterV5__factory

	console.log('Deploying oneInchAggrV5')

	const oneInchAggrV5_instance = await oneInchAggrV5_factory.deploy(weth_address)
	await oneInchAggrV5_instance.deployed()

	console.log(`oneInchAggrV5 deployed to: ${oneInchAggrV5_instance.address}`)

	const USDT_instance = (await ethers.getContractAt(
		'@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20',
		usdt_address,
		my_signer,
	)) as IERC20

	const approveTxToMyInstance = (
		await USDT_instance.connect(my_signer).approve(
			oneInchAggrV5_instance.address,
			ethers.constants.MaxUint256,
		)
	).wait()

	console.log(`Approved ${srcAmount} USDT for ${oneInchAggrV5_instance.address}`)

	// const injectedData = await oneInchCustomUnoswapTo(
	// 	oneInchAggrV5_instance.address,
	// 	srcAmount,
	// 	another_account,
	// 	[usdt_address, weth_address],
	// )
	// logPrtyJSON(injectedData, 'injectedData:')

	// await wait5sec()

	// const txToMyInstance = my_signer.sendTransaction({
	// 	to: oneInchAggrV5_instance.address,
	// 	data: injectedData.tx.data,
	// 	value: 0,
	// })

	// const receipt = await getReceipt(txToMyInstance)
}
