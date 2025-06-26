// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	getDeployerSigner,
	_deployTags,
	deployContract,
	isTestnet,
} from '../scripts/_deploy_helpers'

const deployQuexCore: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping Quex deployment`)
		return
	}

	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying QuexCore...')

	await deployContract(hre, {
			deploymentName: 'QuexCore',
			from: deployerSigner.address,
			args: [],
			log: true,
			skipIfAlreadyDeployed: true,
			contract: 'QuexCore',
	})

	console.log(`\n QuexCore deployed!`)

	console.log('\nDeploying QuexPool...')

	await deployContract(hre, {
			deploymentName: 'QuexPool',
			from: deployerSigner.address,
			args: [],
			log: true,
			skipIfAlreadyDeployed: true,
			contract: 'QuexPool',
	})

	console.log(`\n QuexPool deployed!`)
}

export default deployQuexCore
deployQuexCore.dependencies = _deployTags([])
deployQuexCore.tags = _deployTags(['QuexCore'])
