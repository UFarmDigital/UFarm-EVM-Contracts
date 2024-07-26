// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	deployContract,
	getInstanceFromDeployment,
	getDeployerSigner,
	_deployTags,
} from '../scripts/_deploy_helpers'

const deployOneInch: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping OneInch deployment`)
		return
	}

	const deployerSigner = await getDeployerSigner(hre)
	const weth_deployment = await hre.deployments.get('WETH')

	console.log('\nDeploying OneInch...')

	const oneInchV5Aggregator_deployment = await deployContract(hre, {
		deploymentName: 'AggregationRouterV5',
		from: deployerSigner.address,
		args: [weth_deployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'AggregationRouterV5',
	})

	console.log('\n OneInch deployed!')
}

export default deployOneInch
deployOneInch.dependencies = _deployTags(['Tokens'])
deployOneInch.tags = _deployTags(['OneInch'])
