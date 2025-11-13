// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
	isTestnet,
	getTokenDeployments,
	retryOperation,
	getInstanceFromDeployment,
	getDeployerSigner,
	_deployTags,
} from '../scripts/_deploy_helpers'
import { BigNumberish } from 'ethers'
import { NonfungiblePositionManager, StableCoin, UniswapV3Factory, WETH9 } from '../typechain-types'
import {
	MintableToken,
	addLiquidityUniswapV3,
} from '../test/_helpers'

const createUniV3Pairs: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping Uniswap V3 pairs creation`)
		return
	}

	async function isUniswapV3PairExist(
		factoryContract: UniswapV3Factory,
		token0Address: string,
		token1Address: string,
		fee: number,
	): Promise<boolean> {
		try {
			const pairAddress = await factoryContract.getPool(token0Address, token1Address, fee)
			return pairAddress !== hre.ethers.constants.AddressZero
		} catch (error) {
			console.error('Error checking pair existence:', error)
			return false
		}
	}

	async function checkAndCreateUniV3Pair(
		token0Contract: MintableToken,
		token1Contract: MintableToken,
		amount0: BigNumberish,
		amount1: BigNumberish,
		fee: number,
		signer: SignerWithAddress,
		factoryContract: UniswapV3Factory,
		positionManager: NonfungiblePositionManager,
		maxRetries: number,
	): Promise<void> {
		const token0Address = token0Contract.address
		const token1Address = token1Contract.address

		const [token0Symbol, token1Symbol] = await Promise.all([
			token0Contract.symbol(),
			token1Contract.symbol(),
		])

		const pairName = `${token0Symbol}/${token1Symbol}`

		if (await isUniswapV3PairExist(factoryContract, token0Address, token1Address, fee)) {
			console.log(`${pairName} pair already exists!`)
		} else {
			console.log(`Creating ${pairName} pair...`)

			await retryOperation(async () => {
				await addLiquidityUniswapV3(
					token0Contract,
					token1Contract,
					amount0,
					amount1,
					factoryContract,
					positionManager,
					signer,
					fee,
				)
			}, maxRetries)
			console.log(`${pairName} pair created!`)
		}
	}

	const tokenDeployments = await getTokenDeployments(hre)
	const deployerSigner = await getDeployerSigner(hre)

	const uniV3Factory_deployment = await hre.deployments.get('UniswapV3Factory')
	const nfpm_deployment = await hre.deployments.get('NonfungiblePositionManager')

	const uniV3Factory_instance = getInstanceFromDeployment<UniswapV3Factory>(
		hre,
		uniV3Factory_deployment,
	)
	const nfpm_instance = getInstanceFromDeployment<NonfungiblePositionManager>(
		hre,
		nfpm_deployment,
	)

	const allPairs = hre.testnetDeployConfig.initialRates

	async function createV3PairForTokens(rate: typeof allPairs[0]) {
		const [token0Name, token1Name] = [rate.rawName0, rate.rawName1]
		const [token0_instance, token1_instance] = [
			getInstanceFromDeployment<MintableToken>(hre, tokenDeployments[token0Name]),
			getInstanceFromDeployment<MintableToken>(hre, tokenDeployments[token1Name]),
		]

		const [decimals0, decimals1] = await Promise.all([
			token0_instance.decimals(),
			token1_instance.decimals(),
		])

		console.log(`decimals0: ${decimals0}, decimals1: ${decimals1}`)

		await checkAndCreateUniV3Pair(
			token0_instance,
			token1_instance,
			rate.amount0,
			rate.amount1,
			3000,
			deployerSigner,
			uniV3Factory_instance,
			nfpm_instance,
			3,
		)
	
	}

	console.log('\nCreating UniswapV3 pairs...')

	for (const rate of allPairs) {
		await createV3PairForTokens(rate)
	}

	console.log('\nUniswapV3 pairs created!')
}

export default createUniV3Pairs
createUniV3Pairs.dependencies = _deployTags(['UniV3', 'Tokens'])
createUniV3Pairs.tags = _deployTags(['UniV3Pairs'])
