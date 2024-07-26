// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployerSigner, deployBeaconContract, _deployTags } from '../scripts/_deploy_helpers'

const deployPoolAdmin: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying PoolAdmin...')

	await deployBeaconContract(hre, 'PoolAdmin', deployerSigner)

	console.log('\n PoolAdmin deployed!')
}

export default deployPoolAdmin
deployPoolAdmin.dependencies = []
deployPoolAdmin.tags = _deployTags(['PoolAdmin'])
