// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import * as dotenv from 'dotenv'
import hre from 'hardhat'
import fs from 'fs'
import {
	PoolCreationStruct,
	constants,
	deployPool,
	encodePoolSwapDataUniswapV2,
	encodePoolAddLiqudityDataUniswapV2,
	getEventFromTx,
	mintAndDeposit,
	getBlockchainTimestamp,
	mintAndCreatePairUniV2,
	mintAndCreatePairUniV2WithEth,
	logChangeBalanceWrapper,
	packPerformanceCommission,
} from '../test/_helpers'
import {
	IERC20,
	IERC20Metadata__factory,
	PoolAdmin,
	PriceOracle,
	UFarmCore,
	UFarmPool,
	UniswapV2Factory,
} from '../typechain-types'
import { BigNumber } from 'ethers'
import { customSetTimeout, retryOperation } from './_deploy_helpers'

dotenv.config()

type ContractInfo = {
	address: string
	abi: any[]
}

type RequiredContracts = 'UFarmCore' | 'TestFund' | 'USDT' | 'USDC' | 'WETH'

type Deployments = {
	name: string
	chainId: string
	contracts: {
		[contractName in RequiredContracts]: ContractInfo
	}
}

async function isUniswapV2PairExist(
	factoryContract: UniswapV2Factory,
	token0Address: string,
	token1Address: string,
): Promise<boolean> {
	try {
		const pairAddress = await factoryContract.getPair(token0Address, token1Address)
		return (await hre.ethers.provider.getCode(pairAddress)) !== '0x'
	} catch (error) {
		console.error('Error checking pair existence:', error)
		return false
	}
}

const increaseGasLimit = (estimatedGasLimit: BigNumber) => {
	return estimatedGasLimit.mul(130).div(100) // increase by 30%
}

async function main(iterations: number = 150_000, pool1_addr?: string, pool2_addr?: string) {
	console.log('Starting pool data script...')

	const [deployer, alice, bob, carol, david, emma] = await ethers.getSigners()

	const deployConfig: Deployments = JSON.parse(fs.readFileSync(hre.deploymentsJsonPath, 'utf8'))

	const [core_addr, fund_addr, usdt_addr, usdc_addr, weth_addr] = [
		deployConfig.contracts.UFarmCore.address,
		deployConfig.contracts.TestFund.address,
		deployConfig.contracts.USDT.address,
		deployConfig.contracts.USDC.address,
		deployConfig.contracts.WETH.address,
	]

	const [core_instance, fund_instance, usdt_instance, usdc_instance, weth_instance] = [
		await ethers.getContractAt('UFarmCore', core_addr, deployer),
		await ethers.getContractAt('UFarmFund', fund_addr, deployer),
		await ethers.getContractAt('StableCoin', usdt_addr, deployer),
		await ethers.getContractAt('StableCoin', usdc_addr, deployer),
		await ethers.getContractAt('WETH9', weth_addr, deployer),
	]

	// Create 2 new pools

	const getPools = async (pool1_addr?: string, pool2_addr?: string) => {
		if (pool1_addr && pool2_addr) {
			return [
				await ethers.getContractAt('UFarmPool', pool1_addr, david),
				await ethers.getContractAt('UFarmPool', pool2_addr, emma),
			]
		}

		const emptyPoolArgs: PoolCreationStruct = {
			minInvestment: 0,
			maxInvestment: hre.ethers.constants.MaxUint256,
			managementCommission: hre.ethers.constants.One.div(101),
			packedPerformanceCommission: packPerformanceCommission([{
				step: 0,
				commission: Math.floor(constants.Pool.Commission.MAX_PERFORMANCE_COMMISION / 80)
			}]),
			withdrawalLockupPeriod: 0,
			valueToken: usdt_addr,
			staff: [],
			name: 'name',
			symbol: 'symbol',
		}

		const pool1 = (
			await retryOperation(async () => {
				return await deployPool(
					{ ...emptyPoolArgs, name: 'Data-Pool-1', symbol: 'dp-1' },
					fund_instance,
				)
			}, 5)
		).pool.connect(david)

		const pool2 = (
			await retryOperation(async () => {
				return await deployPool(
					{ ...emptyPoolArgs, name: 'Data-Pool-2', symbol: 'dp-2' },
					fund_instance,
				)
			}, 5)
		).pool.connect(emma)

		console.log(`Pools:\n${pool1.address}\n${pool2.address}`)

		// Deposit 10k USDT into each pool
		const tenThousandBucks = BigNumber.from(10_000).mul(1e6)
		await usdt_instance.mint(fund_addr, tenThousandBucks.mul(2))
		console.log('Minted 20k USDT to fund contract')

		await retryOperation(async () => {
			await fund_instance.depositToPool(pool1.address, tenThousandBucks)
		}, 5)
		console.log('Deposited 10k USDT into pool 1')

		await retryOperation(async () => {
			await fund_instance.depositToPool(pool2.address, tenThousandBucks)
		}, 5)
		console.log('Deposited 10k USDT into pool 2')

		// Buy USDC and WETH with USDT on UniswapV2 for each pool
		const buyUSDCdata = async () => {
			return encodePoolSwapDataUniswapV2(
				tenThousandBucks.div(2),
				BigNumber.from(1000),
				(await getBlockchainTimestamp(hre.ethers.provider)) + 200,
				[usdt_addr, usdc_addr],
			)
		}

		const buyWETHdata = async () => {
			return encodePoolSwapDataUniswapV2(
				tenThousandBucks.div(2),
				BigNumber.from(1000),
				(await getBlockchainTimestamp(hre.ethers.provider)) + 200,
				[usdt_addr, weth_addr],
			)
		}

		await retryOperation(async () => {
			await (
				await pool1.protocolAction(
					constants.UFarm.prtocols.UniswapV2ProtocolString,
					await buyUSDCdata(),
				)
			).wait()
		}, 5)
		console.log(`Bought ${await usdc_instance.balanceOf(pool1.address)} USDC with USDT on pool 1`)

		await retryOperation(async () => {
			await (
				await pool2.protocolAction(
					constants.UFarm.prtocols.UniswapV2ProtocolString,
					await buyUSDCdata(),
				)
			).wait()
		}, 5)
		console.log(`Bought ${await usdc_instance.balanceOf(pool2.address)} USDC with USDT on pool 2`)

		await retryOperation(async () => {
			await (
				await pool1.protocolAction(
					constants.UFarm.prtocols.UniswapV2ProtocolString,
					await buyWETHdata(),
				)
			).wait()
		}, 5)
		console.log(`Bought ${await weth_instance.balanceOf(pool1.address)} WETH with USDT on pool 1`)

		await retryOperation(async () => {
			await (
				await pool2.protocolAction(
					constants.UFarm.prtocols.UniswapV2ProtocolString,
					await buyWETHdata(),
				)
			).wait()
		}, 5)
		console.log(`Bought ${await weth_instance.balanceOf(pool2.address)} WETH with USDT on pool 2`)

		// Become liquidity provider of USDC/WETH pair
		const addLiquidityData = async (pool: UFarmPool) => {
			const [usdcBalance, wethBalance] = await Promise.all([
				usdc_instance.balanceOf(pool.address),
				weth_instance.balanceOf(pool.address),
			])

			const UniV2Controller_addr = await core_instance.controllers(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
			)

			const UniV2Controller_instance = await ethers.getContractAt(
				'UnoswapV2Controller',
				UniV2Controller_addr,
				deployer,
			)

			const getQuotedAmounts = async (): ReturnType<
				typeof UniV2Controller_instance.quoteExactLiquidityAmounts
			> => {
				try {
					const quotedAmounts = await UniV2Controller_instance.quoteExactLiquidityAmounts(
						usdc_addr,
						weth_addr,
						usdcBalance,
						wethBalance,
						1000,
						1000,
						(await getBlockchainTimestamp(hre.ethers.provider)) + 200,
					)

					console.log(
						`Quoted amounts: ${quotedAmounts[0].toString()}, ${quotedAmounts[1].toString()}`,
					)

					return quotedAmounts
				} catch (error) {
					console.log('Checking for pair existence...')
					const [factory_addr, router_addr] = await Promise.all([
						UniV2Controller_instance.factory(),
						UniV2Controller_instance.router(),
					])
					const factory_instance = await ethers.getContractAt(
						'UniswapV2Factory',
						factory_addr,
						deployer,
					)
					const router_instance = await ethers.getContractAt(
						'UniswapV2Router02',
						router_addr,
						deployer,
					)
					if (await isUniswapV2PairExist(factory_instance, usdc_addr, weth_addr)) {
						console.log('Pair already exists')
					} else {
						await mintAndCreatePairUniV2WithEth(
							usdc_instance,
							BigNumber.from(10).pow(6).mul(2000),
							constants.ONE,
							deployer,
							router_instance,
						)
						console.log('Pair created!')
					}
					// retry
					return await getQuotedAmounts()
				}

			}

			await getQuotedAmounts()

			return encodePoolAddLiqudityDataUniswapV2(
				usdc_addr,
				weth_addr,
				usdcBalance.div(2),
				wethBalance.div(2),
				1000,
				1000,
				(await getBlockchainTimestamp(hre.ethers.provider)) + 200,
			)
		}

		const poolAddLiquidity = async (pool: UFarmPool) => {
			const addLiqData = await addLiquidityData(pool)
			const estimateAddLiquidty = await pool.estimateGas.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				addLiqData,
			)

			const receiptAddLiq = await (
				await pool.protocolAction(constants.UFarm.prtocols.UniswapV2ProtocolString, addLiqData, {
					gasLimit: increaseGasLimit(estimateAddLiquidty),
				})
			).wait()

			console.log(`Added liquidity to pool ${pool.address} in block ${receiptAddLiq.blockNumber}`)
		}

		await poolAddLiquidity(pool1)
		await poolAddLiquidity(pool2)

		console.log('Preparation done!')

		return [pool1, pool2]
	}

	const [pool1, pool2] = await getPools(pool1_addr, pool2_addr)

	const ufarmCore_addr = await pool1.ufarmCore()
	const ufarmCore_instance = await ethers.getContractAt('UFarmCore', ufarmCore_addr, deployer)

	const UnoswapV2Controller_addr = await ufarmCore_instance.controllers(
		constants.UFarm.prtocols.UniswapV2ProtocolString,
	)

	const UnoswapV2Controller_instance = await ethers.getContractAt(
		'UnoswapV2Controller',
		UnoswapV2Controller_addr,
		deployer,
	)

	const encodeSwapOfHalf = async (pool: UFarmPool, swapTo: string, swapFrom: string) => {
		const swapFrom_instance = IERC20Metadata__factory.connect(swapFrom, deployer)
		const swapTo_instance = IERC20Metadata__factory.connect(swapTo, deployer)

		const [symbol1, symbol2] = await Promise.all([
			swapFrom_instance.symbol(),
			swapTo_instance.symbol(),
		])

		const amountToSwap = (await swapFrom_instance.balanceOf(pool.address)).div(2)
		const timestamp = (await getBlockchainTimestamp(hre.ethers.provider)) + 200
		const amountOut = await UnoswapV2Controller_instance.getAmountOut(amountToSwap, [
			swapFrom,
			swapTo,
		])

		console.log(
			`Going to swap ${amountToSwap.toString()} ${symbol1} to ${amountOut.toString()} ${symbol2}`,
		)

		return encodePoolSwapDataUniswapV2(amountToSwap, BigNumber.from(10000), timestamp, [
			swapFrom,
			swapTo,
		])
	}

	async function threeRetries<T>(fn: () => Promise<T>): Promise<T> {
		return await retryOperation(async () => {
			return fn()
		}, 3)
	}

	async function logBalanceSwapRetry<T>(pool: UFarmPool, token1: string, token2: string) {
		return await logChangeBalanceWrapper(
			async () => {
				return await threeRetries(async () => {
					const encodedSwap1 = await encodeSwapOfHalf(pool, token1, token2)

					const estimatedGasLimit = await pool.estimateGas.protocolAction(
						constants.UFarm.prtocols.UniswapV2ProtocolString,
						encodedSwap1,
					)

					return await (
						await pool.protocolAction(
							constants.UFarm.prtocols.UniswapV2ProtocolString,
							encodedSwap1,
							{
								gasLimit: increaseGasLimit(estimatedGasLimit),
							},
						)
					).wait()
				})
			},
			pool.address,
			token1,
			token2,
		)
	}

	const swapToAndFrom = async (pool: UFarmPool, swapTo: string, swapFrom: string) => {
		const receiptTo = await logBalanceSwapRetry(pool, swapTo, swapFrom)
		console.log(`Block: ${receiptTo.blockNumber}`)

		await customSetTimeout(15)

		const receiptFrom = await logBalanceSwapRetry(pool, swapFrom, swapTo)
		console.log(`Block: ${receiptFrom.blockNumber}`)
		await customSetTimeout(15)

	}

	for (let i = 0; i < iterations; i++) {
		console.log(`Iteration ${i + 1} from ${iterations}`)

		await swapToAndFrom(pool1, usdc_addr, weth_addr)
		console.log('Swapped USDC <=> WETH on pool 1')

		await swapToAndFrom(pool2, usdc_addr, weth_addr)
		console.log('Swapped USDC <=> WETH on pool 2\n')
	}

	// TODO: sell liquidity and buy it again
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
