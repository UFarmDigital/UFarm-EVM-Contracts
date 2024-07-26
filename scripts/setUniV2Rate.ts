// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import * as dotenv from 'dotenv'
import hre from 'hardhat'
import fs from 'fs'
import { MintableToken, setExchangeRate } from '../test/_helpers'
import { UniswapV2Factory } from '../typechain-types'
import { BigNumber, BigNumberish } from 'ethers'
import { customSetTimeout, getInstanceFromDeployment } from './_deploy_helpers'

dotenv.config()

type ContractInfo = {
	address: string
	abi: any[]
}

type Deployments = {
	name: string
	chainId: string
	contracts: {
		[contractName in RequiredContracts]: ContractInfo
	}
}

const StableCoins = [`USDT`, `USDC`, `DAI`]
const EthersCoins = [`WETH`, `STETH`, `WSTETH`]
const IgnoringCoins: string[] = []
const CommonCoins = [`WBTC`, `MKR`]
const AllCoins = [...StableCoins, ...EthersCoins, ...IgnoringCoins, ...CommonCoins]

type RequiredContracts = (typeof AllCoins)[number] | 'UFarmCore' | 'TestFund' | 'UniswapV2Factory'

type Rate = {
	rawName0: (typeof AllCoins)[number]
	rawName1: (typeof AllCoins)[number]
	amount0: BigNumberish
	amount1: BigNumberish
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

const interval = 50 * 60 // 50 minutes in seconds
const day = 24 * 60 * 60 // 24 hours in seconds

async function main() {
	async function getCurrentPrice(
		tokenA: MintableToken,
		tokenB: MintableToken,
		factory: UniswapV2Factory,
	) {
		const pairAddress = await factory.getPair(tokenA.address, tokenB.address)
		const pair = await ethers.getContractAt('UniswapV2Pair', pairAddress, deployer)
		const [reserve0, reserve1] = await pair.getReserves()
		return reserve0
			.mul(10n ** BigInt(await tokenB.decimals()))
			.div(reserve1)
			.mul(997)
			.div(1000)
	}
	function addSinMultiplier(rate: BigNumber, iteration: number): BigNumber {
		let toAdd = rate.mul(interval).div(day).div(10) // 10% of daily rate
		const sinMultiplier = Math.floor(Math.sin(iteration) * 100) + 30
		return rate.add(toAdd.mul(sinMultiplier).div(10))
	}

	console.log('Starting pool data script...')
	const [deployer] = await ethers.getSigners()

	const deploymentsConfig: Deployments = JSON.parse(
		fs.readFileSync(hre.deploymentsJsonPath, 'utf8'),
	)
	const deployConfigRates = hre.testnetDeployConfig.initialRates as Rate[]

	const deployedContracts = deploymentsConfig.contracts

	const [uniV2factory_instance] = await Promise.all([
		ethers.getContractAt('UniswapV2Factory', deployedContracts.UniswapV2Factory.address, deployer),
	])

	for (let iteration = 0; iteration < 15000000; iteration++) {
		// let thisIterationETHUSDprice = BigNumber.from(0)
		// let thisIterationUSDdecimals = 0

		for (let i = 0; i < deployConfigRates.length; i++) {
			const thisRateConfig = deployConfigRates[i]
			let newRate = BigNumber.from(0)

			let [amount0, amount1] = [
				BigNumber.from(thisRateConfig.amount0),
				BigNumber.from(thisRateConfig.amount1),
			]
			const pairName = `${thisRateConfig.rawName0}/${thisRateConfig.rawName1}`

			let [token0, token1] = [
				await getInstanceFromDeployment<MintableToken>(
					hre,
					deploymentsConfig.contracts[thisRateConfig.rawName0],
				),
				await getInstanceFromDeployment<MintableToken>(
					hre,
					deploymentsConfig.contracts[thisRateConfig.rawName1],
				),
			]

			if (!token0 || !token1) {
				throw new Error('Unknown token in pair: ' + pairName)
			}

			const isExist = await isUniswapV2PairExist(
				uniV2factory_instance,
				token0.address,
				token1.address,
			)
			if (!isExist) {
				console.log(`Pair ${pairName} not exist, skipping...`)
				continue
			}

			const uniV2pool_addr = await uniV2factory_instance.getPair(token0.address, token1.address)
			let [decimals0, decimals1] = [await token0.decimals(), await token1.decimals()]

			{
				const isStable = {
					a: StableCoins.includes(thisRateConfig.rawName0),
					b: StableCoins.includes(thisRateConfig.rawName1),
				}

				if (isStable.a && isStable.b) {
					console.log(
						`Ignoring pair ${thisRateConfig.rawName0}/${thisRateConfig.rawName1} because of stable coins`,
					)
					continue
				}

				const isEthers = {
					a: EthersCoins.includes(thisRateConfig.rawName0),
					b: EthersCoins.includes(thisRateConfig.rawName1),
				}

				if (isEthers.a && isEthers.b) {
					console.log(
						`Ignoring pair ${thisRateConfig.rawName0}/${thisRateConfig.rawName1} because of ethers coins`,
					)
					continue
				}

				if ((isEthers.a && isStable.b) || (isEthers.b && isStable.a)) {
					const stableA_etherB = isEthers.a && isStable.b
				}

				const isCommon = {
					a: CommonCoins.includes(thisRateConfig.rawName0),
					b: CommonCoins.includes(thisRateConfig.rawName1),
				}

				const isIgnoring = {
					a: IgnoringCoins.includes(thisRateConfig.rawName0),
					b: IgnoringCoins.includes(thisRateConfig.rawName1),
				}

				if (isIgnoring.a || isIgnoring.b) {
					console.log(
						`Ignoring pair ${thisRateConfig.rawName0}/${
							thisRateConfig.rawName1
						} because of ignoring coin (${
							isIgnoring.a ? thisRateConfig.rawName0 : thisRateConfig.rawName1
						})`,
					)
					continue
				}
			}

			console.log(`\n\nRate: ${JSON.stringify(thisRateConfig)}`)

			const uniV2pool_instance = await ethers.getContractAt(
				'UniswapV2Pair',
				uniV2pool_addr,
				deployer,
			)

			const pairToken0 = await uniV2pool_instance.token0()
			const isReveresed = pairToken0 === token1.address

			let [reserve0, reserve1] = await uniV2pool_instance.getReserves()
			if (isReveresed) {
				;[reserve0, reserve1] = [reserve1, reserve0]
			}

			let originalRate = amount1.mul(10n ** BigInt(decimals0)).div(amount0)
			let actualRate = reserve1.mul(10n ** BigInt(decimals0)).div(reserve0)
			let reversedRate = reserve0.mul(10n ** BigInt(decimals1)).div(reserve1)

			console.log(
				`Original rate: ${originalRate.toString()}\nActual rate: ${actualRate.toString()}\nReversed actual rate: ${reversedRate.toString()}`,
			)

			if (newRate.isZero()) {
				newRate = addSinMultiplier(actualRate, iteration)
			}
			let newRateRevesed = BigNumber.from(10n ** BigInt(decimals0 + decimals1) / newRate.toBigInt())

			console.log(`New rate: ${newRate.toString()}, reversed: ${newRateRevesed}`)

			await customSetTimeout(3)

			console.log(
				`token0: ${token0.address}\ntoken1: ${
					token1.address
				}\nnewRate: ${newRate.toString()}\ndeployer: ${deployer.address}\nuniV2factory_instance: ${
					uniV2factory_instance.address
				}`,
			)

			await setExchangeRate(token0, token1, newRateRevesed, deployer, uniV2factory_instance)
			await customSetTimeout(3)

			const rateAfterChanging = await getCurrentPrice(token0, token1, uniV2factory_instance)

			console.log(`Rate after changing: ${rateAfterChanging.toString()}\n`)
		}

		console.log(`Iteration ${iteration} finished!\n\n\n`)
		await customSetTimeout(1) // 50 minutes
	}

	console.log('Pool data script done!')

	process.exit(0)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
