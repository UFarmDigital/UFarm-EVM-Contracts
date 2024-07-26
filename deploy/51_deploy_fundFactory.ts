// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { isTestnet, getDeployerSigner, deployContract, _deployTags } from '../scripts/_deploy_helpers'

const deployFundFactory: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	const ufarmCore_deployment = await hre.deployments.get('UFarmCore')
	const ufarmFund_deployments = await hre.deployments.get('UFarmFund')

	console.log('\nDeploying FundFactory...')

	await deployContract(hre, {
		deploymentName: 'FundFactory',
		from: deployerSigner.address,
		args: [ufarmCore_deployment.address, ufarmFund_deployments.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'FundFactory',
	})

	console.log('\n FundFactory deployed!')
}

export default deployFundFactory
deployFundFactory.dependencies = _deployTags(['UFarmCore', 'UFarmPool', 'PoolAdmin','UFarmFund'])
deployFundFactory.tags = _deployTags(['FundFactory'])
