// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployerSigner, deployBeaconContract, _deployTags } from '../scripts/_deploy_helpers'

const deployPool: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying UFarmPool...')

	await deployBeaconContract(hre, 'UFarmPool', deployerSigner, {
		unsafeSkipStorageCheck: false
	})

	console.log('\n UFarmPool deployed!')
}

export default deployPool
deployPool.dependencies = []
deployPool.tags = _deployTags(['UFarmPool'])
