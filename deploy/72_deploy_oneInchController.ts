// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployerSigner, _deployTags, deployUpgradedContract } from '../scripts/_deploy_helpers'

const deployOneInchController: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	const oneInchDeployment = await hre.deployments.get('AggregationRouterV5')

	await deployUpgradedContract(hre, {
		deploymentName: 'OneInchV5Controller',
		from: deployerSigner.address,
		args: [oneInchDeployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'OneInchV5Controller',
		estimateGasExtra: 100000,
	})
}

export default deployOneInchController
deployOneInchController.dependencies = _deployTags(['OneInch'])
deployOneInchController.tags = _deployTags(['OneInchV5Controller'])
