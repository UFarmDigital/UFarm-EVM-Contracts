// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	deployContract,
	_deployTags,
} from '../scripts/_deploy_helpers'
import { UniswapV2Pair__factory } from '../typechain-types'
import { getInitCodeHash } from '../test/_helpers'

const deployUniV2Controller: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping UniV2 controller deployment`)
		return
	}

	const deployerSigner = await getDeployerSigner(hre)
	const uniV2Router_deployment = await hre.deployments.get('UniswapV2Router02')
	const uniV2Factory_deployment = await hre.deployments.get('UniswapV2Factory')
	const priceOracle_deployment = await hre.deployments.get('PriceOracle')

	const init_code_hash = await getInitCodeHash(UniswapV2Pair__factory.bytecode)

	console.log('\nDeploying UnoswapV2Controller...')

	await deployContract(hre, {
		deploymentName: 'UniV2Controller',
		from: deployerSigner.address,
		args: [
			uniV2Factory_deployment.address,
			uniV2Router_deployment.address,
			priceOracle_deployment.address,
			init_code_hash,
		],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'UniswapV2ControllerUFarm', // only for testnet
	})

	console.log('UnoswapV2Controller deployed!')
}

export default deployUniV2Controller
deployUniV2Controller.dependencies = _deployTags(['PrepareEnvARB', 'UniV2', 'PriceOracle', 'Tokens'])
deployUniV2Controller.tags = _deployTags(['UniV2Controller'])
