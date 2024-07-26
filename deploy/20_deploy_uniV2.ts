// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	deployContract,isTestnet,
	getTokenDeployments,
	getDeployerSigner,
	_deployTags,
} from '../scripts/_deploy_helpers'

const deployUniV2: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping Uniswap V2 deployment`)
		return
	}

	const tokenDeployments = await getTokenDeployments(hre)
	const weth_deployment = tokenDeployments.WETH

	console.log('\nDeploying Uniswap V2...')

	const deployerSigner = await getDeployerSigner(hre)

	const uniswapV2Factory_deployment = await deployContract(hre, {
		deploymentName: 'UniswapV2Factory',
		from: deployerSigner.address,
		args: [deployerSigner.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'UniswapV2Factory',
	})

	const uniswapV2Router_deployment = await deployContract(hre, {
		deploymentName: 'UniswapV2Router02',
		from: deployerSigner.address,
		args: [uniswapV2Factory_deployment.address, weth_deployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'UniswapV2Router02',
	})

	console.log('\nUniswap V2 deployed!')
}

export default deployUniV2
deployUniV2.dependencies = _deployTags(['Tokens'])
deployUniV2.tags = _deployTags(['UniV2'])
