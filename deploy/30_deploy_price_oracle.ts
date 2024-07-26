// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	deployProxyContract,
	getDeployerSigner,
	getPriceOracleContract,
	_deployTags,
} from '../scripts/_deploy_helpers'

const deployPriceOracle: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying PriceOracle...')
	const priceOracleContract = getPriceOracleContract(hre.network)
	await deployProxyContract(
		hre,
		priceOracleContract.contract,
		deployerSigner,
		undefined,
		{
			kind: 'uups',
		},
		'PriceOracle',
	)

	console.log(`\n ${priceOracleContract.contract} deployed!`)
}

export default deployPriceOracle
deployPriceOracle.dependencies = _deployTags([])
deployPriceOracle.tags = _deployTags(['PriceOracle'])
