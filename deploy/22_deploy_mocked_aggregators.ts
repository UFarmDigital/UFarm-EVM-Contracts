// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction, Deployment } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	deployContract,
	isTestnet,
	getTokenDeployments,
	getInstanceFromDeployment,
	mockedAggregatorName,
	getDeployerSigner,
	_deployTags,
} from '../scripts/_deploy_helpers'
import { StableCoin, UniswapV2Router02 } from '../typechain-types'

const deployMockedAggregators: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)) {
		console.log(`Skipping Mocked Aggregators deployment`)
		return
	}

	const tokenDeployments = await getTokenDeployments(hre)
	const deployerSigner = await getDeployerSigner(hre)

	const usdt_instance = getInstanceFromDeployment<StableCoin>(hre, tokenDeployments.USDT)

	const uniswapV2Router_deployment = await hre.deployments.get('UniswapV2Router02')
	const uniswapV2Router_instance = getInstanceFromDeployment<UniswapV2Router02>(
		hre,
		uniswapV2Router_deployment,
	)

	console.log('\nDeploying Mocked ChainLink Aggregators...')

	async function deployMockedAggregator(
		token: string,
		tokenDeployment: Deployment,
		args: any[] = [
			8,
			uniswapV2Router_instance.address,
			tokenDeployment.address,
			usdt_instance.address,
		],
	) {
		const mockedAggregator = mockedAggregatorName(token, hre.network)
		console.log(`Deploying ${mockedAggregator} ...`)
		return await deployContract(hre, {
			deploymentName: mockedAggregator,
			from: deployerSigner.address,
			args: args,
			log: true,
			skipIfAlreadyDeployed: true,
			contract: 'UFarmMockV3Aggregator',
		})
	}

	async function getStETHOracleOrDeploy(): Promise<{
		stETHUSD: Deployment
		wstETHstETH: Deployment
	}> {
		const steth_oracle_deployment = await hre.deployments.getOrNull(
			mockedAggregatorName('STETH', hre.network),
		)
		const lido_oracle_deployment = await hre.deployments.getOrNull(
			'LidoRateOracle'
		)

		if (!steth_oracle_deployment || !lido_oracle_deployment) {
			const steth_deployment = tokenDeployments.STETH
			const wsteth_deployment = tokenDeployments.WSTETH

			const stETHUSD = await deployMockedAggregator('STETH', steth_deployment, [
				18,
				uniswapV2Router_instance.address,
				steth_deployment.address,
				usdt_instance.address,
			])
			const wstETHstETH = await deployContract(hre, {
				deploymentName: 'LidoRateOracle',
				from: deployerSigner.address,
				args: [wsteth_deployment.address],
				log: true,
				skipIfAlreadyDeployed: true,
				contract: 'MockV3wstETHstETHAgg',
			})
			return {
				stETHUSD,
				wstETHstETH,
			}
		} else {
			return {
				stETHUSD: steth_oracle_deployment,
				wstETHstETH: lido_oracle_deployment,
			}
		}
	}

	console.log(`AllTokens: ${Object.keys(tokenDeployments)}`)

	for (const [token, deployment] of Object.entries(tokenDeployments)) {
		if (token === 'STETH') {
			console.log('Skipping STETH Aggregator')
			continue
		}

		const aggregatorName = mockedAggregatorName(token, hre.network)

		console.log(`Deploying ${aggregatorName} ...`)

		if (token === 'WSTETH') {
			// Check for STETH oracle
			const steth_oracle_deployment = await getStETHOracleOrDeploy()
		} else {
			await deployMockedAggregator(token, deployment)
		}
	}

	console.log('\nMocked ChainLink Aggregators deployed!')
}

export default deployMockedAggregators
deployMockedAggregators.dependencies = _deployTags(['UniV2Pairs','Lido'])
deployMockedAggregators.tags = _deployTags(['MockedAggregators'])
