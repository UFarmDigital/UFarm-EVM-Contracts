// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	getDeployerSigner,
	deployContract,
	_deployTags,
} from '../scripts/_deploy_helpers'

const deployPoolFactory: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {

	const deployerSigner = await getDeployerSigner(hre)

	const ufarmCore_deployment = await hre.deployments.get('UFarmCore')
	const pool_beacon_deployment = await hre.deployments.get('UFarmPool')
	const poolAdmin_beacon_deployment = await hre.deployments.get('PoolAdmin')

	console.log('\nDeploying PoolFactory...')

	await deployContract(hre, {
		deploymentName: 'PoolFactory',
		from: deployerSigner.address,
		args: [ufarmCore_deployment.address, pool_beacon_deployment.address, poolAdmin_beacon_deployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'PoolFactory',
	})

	console.log('\n PoolFactory deployed!')
}

export default deployPoolFactory
deployPoolFactory.dependencies = _deployTags(['UFarmCore', 'UFarmPool', 'PoolAdmin'])
deployPoolFactory.tags = _deployTags(['PoolFactory'])
