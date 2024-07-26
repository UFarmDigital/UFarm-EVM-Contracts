// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployerSigner, deployBeaconContract, _deployTags } from '../scripts/_deploy_helpers'

const deployFund: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying UFarmFund...')

	await deployBeaconContract(hre, 'UFarmFund', deployerSigner)

	console.log('\n UFarmFund deployed!')
}

export default deployFund
deployFund.dependencies = []
deployFund.tags = _deployTags(['UFarmFund'])
