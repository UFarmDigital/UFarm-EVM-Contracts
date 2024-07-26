// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	deployContract,
	isTestnet,
	getTokenDeployments,
	getDeployerSigner,
	getInstanceFromDeployment,
	_deployTags,
} from '../scripts/_deploy_helpers'
import { ethers } from 'hardhat'
import { UniswapV3Factory } from '../typechain-types'

const deployUniV3: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
		console.log(`Skipping Uniswap V3 deployment`)
		return
	}

	const tokenDeployments = await getTokenDeployments(hre)
	const weth_deployment = tokenDeployments.WETH

	console.log('\nDeploying UniswapV3...')

	const deployerSigner = await getDeployerSigner(hre)

	const uniswapV3Factory_deployment = await deployContract(hre, {
		deploymentName: 'UniswapV3Factory',
		from: deployerSigner.address,
		args: [],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'UniswapV3Factory',
	})

	const uniswapV3Factory_instance = await getInstanceFromDeployment<UniswapV3Factory>(
		hre,
		uniswapV3Factory_deployment,
	)
	if ((await uniswapV3Factory_instance.feeAmountTickSpacing(100)) == 0)
		await (await uniswapV3Factory_instance.connect(deployerSigner).enableFeeAmount(100, 1)).wait()

	const uniswapV3_SwapRouter_deployment = await deployContract(hre, {
		deploymentName: 'SwapRouter',
		from: deployerSigner.address,
		args: [uniswapV3Factory_deployment.address, weth_deployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'SwapRouter',
	})

	const uniswapV3_NonfungiblePositionManager_deployment = await deployContract(hre, {
		deploymentName: 'NonfungiblePositionManager',
		from: deployerSigner.address,
		args: [
			uniswapV3Factory_deployment.address,
			weth_deployment.address,
			ethers.constants.AddressZero,
		],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'NonfungiblePositionManager',
	})

	const uniswapV3_Quoter_deployment = await deployContract(hre, {
		deploymentName: 'QuoterV2',
		from: deployerSigner.address,
		args: [uniswapV3Factory_deployment.address, weth_deployment.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'QuoterV2',
	})
	console.log('\nUniswapV3 deployed!')
}

export default deployUniV3
deployUniV3.dependencies = _deployTags(['Tokens'])
deployUniV3.tags = _deployTags(['UniV3'])
