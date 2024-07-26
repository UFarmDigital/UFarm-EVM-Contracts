// SPDX-License-Identifier: BUSL-1.1

import { ArtifactData, DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	getPrefixedTokens,
	deployContract,
	isTestnet,
	isPublicTestnet,
	getDeployerSigner,
	_deployTags,
} from '../scripts/_deploy_helpers'

const deployTokens: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)) {
		console.log(`Skipping tokens deployment`)
		return
	}
	const prefixedTokens = await getPrefixedTokens(hre)

	console.log('Deploying tokens...')

	const deployerSigner = await getDeployerSigner(hre)
	const deployer = deployerSigner.address

	for (const token of prefixedTokens) {
		let args: any[] | undefined = undefined
		let contract: string | ArtifactData | undefined = undefined

		switch (token.rawName) {
			case 'WETH':
				contract = 'MockedWETH9'
				break
			case 'STETH':
				if (isPublicTestnet(hre.network)) {
					contract = 'StableCoin'
					args = [token.name, token.symbol, token.decimals]
				} else {
					const steth_deployment = await hre.deployments.getOrNull('STETH')
					if (!steth_deployment) throw new Error(`STETH deployment not found`)
				}
				break
			case 'WSTETH':
				if (isPublicTestnet(hre.network)) {
					contract = 'StableCoin'
					args = [token.name, token.symbol, token.decimals]
				} else {
					const wsteth_deployment = await hre.deployments.getOrNull('WSTETH')
					if (!wsteth_deployment) throw new Error(`WSTETH deployment not found`)
				}
				break
			default:
				contract = 'StableCoin'
				args = [token.name, token.symbol, token.decimals]
				break
		}

		if (contract)
			await deployContract(hre, {
				deploymentName: token.rawName,
				from: deployer,
				args: args,
				log: true,
				contract: contract,
				skipIfAlreadyDeployed: true,
			})
	}

	console.log('Tokens deployed!')
}



export default deployTokens
deployTokens.dependencies = _deployTags(['Lido'])
deployTokens.tags = _deployTags(['Tokens'])
