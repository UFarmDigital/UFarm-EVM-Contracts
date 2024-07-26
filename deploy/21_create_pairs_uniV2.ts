// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
	getTokenDeployments,
	retryOperation,
	getInstanceFromDeployment,
	getDeployerSigner,
	_deployTags,
	isMainnet,
} from '../scripts/_deploy_helpers'
import { BigNumberish } from 'ethers'
import {
	UniswapV2Factory,
	UniswapV2Router02,
} from '../typechain-types'
import {
	mintAndCreatePairUniV2,
	MintableToken,
} from '../test/_helpers'

const createUniV2Pairs: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	async function isUniswapV2PairExist(
		factoryContract: UniswapV2Factory,
		token0Address: string,
		token1Address: string,
	): Promise<boolean> {
		try {
			const pairAddress = await factoryContract.getPair(token0Address, token1Address)
			const hasCode = (await hre.ethers.provider.getCode(pairAddress)) !== '0x'

			if (!hasCode) {
				return false
			}

			const tokenInstance0 = await hre.ethers.getContractAt('StableCoin', token0Address)
			const pairBalance0 = await tokenInstance0.balanceOf(pairAddress)
			const tokenInstance1 = await hre.ethers.getContractAt('StableCoin', token1Address)
			const pairBalance1 = await tokenInstance1.balanceOf(pairAddress)
			return pairBalance0.gt(0) && pairBalance1.gt(0)
		} catch (error) {
			console.error('Error checking pair existence:', error)
			return false
		}
	}

	async function checkAndCreateUniV2Pair(
		factoryContract: UniswapV2Factory,
		token0Contract: MintableToken,
		token1Contract: MintableToken,
		amount0: BigNumberish,
		amount1: BigNumberish,
		signer: SignerWithAddress,
		routerContract: UniswapV2Router02,
		maxRetries: number,
	): Promise<void> {
		const token0Address = token0Contract.address
		const token1Address = token1Contract.address

		const [token0Symbol, token1Symbol] = await Promise.all([
			token0Contract.symbol(),
			token1Contract.symbol(),
		])

		const pairName = `${token0Symbol}/${token1Symbol}`

		if (await isUniswapV2PairExist(factoryContract, token0Address, token1Address)) {
			console.log(`${pairName} pair already exists!`)
		} else {
			console.log(`Creating ${pairName} pair...`)
			await retryOperation(async () => {
				await mintAndCreatePairUniV2(
					token0Contract,
					token1Contract,
					amount0,
					amount1,
					signer,
					routerContract,
				)
			}, maxRetries)

			console.log(`${pairName} pair created!`)
		}
	}

	async function createV2PairForTokens(rate: (typeof allPairs)[0]) {
		const [token0Name, token1Name] = [rate.rawName0, rate.rawName1]
		const [token0_instance, token1_instance] = await Promise.all([
			getInstanceFromDeployment<MintableToken>(hre, tokenDeployments[token0Name]),
			getInstanceFromDeployment<MintableToken>(hre, tokenDeployments[token1Name]),
		])

		const [decimals0, decimals1] = await Promise.all([
			token0_instance.decimals(),
			token1_instance.decimals(),
		])

		console.log(`decimals0: ${decimals0}, decimals1: ${decimals1}`)

		await checkAndCreateUniV2Pair(
			uniV2Factory_instance,
			token0_instance,
			token1_instance,
			rate.amount0,
			rate.amount1,
			deployerSigner,
			uniV2Router_instance,
			3,
		)
	}

	if (isMainnet(hre.network)){
		console.log(`Skipping Uniswap V2 pairs creation`)
		return
	}

	const tokenDeployments = await getTokenDeployments(hre)
	const deployerSigner = await getDeployerSigner(hre)

	const uniV2Router_deployment = await hre.deployments.get('UniswapV2Router02')
	const uniV2Factory_deployment = await hre.deployments.get('UniswapV2Factory')

	const uniV2Router_instance = new hre.ethers.Contract(
		uniV2Router_deployment.address,
		uniV2Router_deployment.abi,
		hre.ethers.provider,
	) as UniswapV2Router02
	const uniV2Factory_instance = new hre.ethers.Contract(
		uniV2Factory_deployment.address,
		uniV2Factory_deployment.abi,
		hre.ethers.provider,
	) as UniswapV2Factory

	console.log('\nCreating Uniswap V2 pairs...')

	const allPairs = hre.testnetDeployConfig.initialRates

	for (const rate of allPairs) {
		await createV2PairForTokens(rate)
	}

	console.log('Uniswap V2 pairs created!')
}

export default createUniV2Pairs
createUniV2Pairs.dependencies = _deployTags(['UniV2'])
createUniV2Pairs.tags = _deployTags(['UniV2Pairs'])
