// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { isTestnet, getDeployerSigner, deployUpgradedContract, _deployTags } from '../scripts/_deploy_helpers'
import { getInitCodeHash } from '../test/_helpers'
import { UniswapV3Pool__factory } from '../typechain-types'

const deployUniV3Controller: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping UniV3 controller deployment`)
		return
	}

	const deployerSigner = await getDeployerSigner(hre)
	const priceOracle_deployment = await hre.deployments.get('PriceOracle')
	const uniV3Factory_deployment = await hre.deployments.get('UniswapV3Factory')
	const swapRouter_deployment = await hre.deployments.get('SwapRouter')
	const nfpm_deployment = await hre.deployments.get('NonfungiblePositionManager')

	console.log('\nDeploying UnoswapV3Controller...')

	await deployUpgradedContract(hre, {
		deploymentName: 'UniV3Controller',
		from: deployerSigner.address,
		args: [
			swapRouter_deployment.address,
			uniV3Factory_deployment.address,
			nfpm_deployment.address,
			priceOracle_deployment.address,
			await getInitCodeHash(UniswapV3Pool__factory.bytecode)
		],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'UniswapV3ControllerUFarm', // only for testnet
	})
	console.log('UnoswapV3Controller deployed!')
}

export default deployUniV3Controller
deployUniV3Controller.dependencies = _deployTags(['UniV3', 'PriceOracle'])
deployUniV3Controller.tags = _deployTags(['UniV3Controller'])
