// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { isTestnet, getDeployerSigner, deployProxyContract, _deployTags } from '../scripts/_deploy_helpers'

const deployUFarmCore: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying UFarmCore...')

	const res = await deployProxyContract(hre, 'UFarmCore', deployerSigner, undefined, {
		kind: 'uups',
	})

	console.log(`UFarmCore deployed at: ${res.address}`)

	console.log('\n UFarmCore deployed!')
}

export default deployUFarmCore
deployUFarmCore.dependencies = []
deployUFarmCore.tags = _deployTags(['UFarmCore'])
