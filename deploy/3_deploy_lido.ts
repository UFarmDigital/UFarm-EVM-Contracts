// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	deployContract,
	getDeployerSigner,
	_deployTags,
	getNetworkType,
	isMainnet,
} from '../scripts/_deploy_helpers'

const deployLido: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)) {
		console.log(`Skipping Lido deployment`)
		return
	}

	if (getNetworkType(hre.network) === 'arbitrumSepolia' || isMainnet(hre.network)) {
		console.log('Skipping Lido deployment')
		return
	}

	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying Lido...')

	const lido_deposit = await deployContract(hre, {
		deploymentName: 'DepositContractMock',
		from: deployerSigner.address,
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'DepositContractMock',
	})

	const lido_registry = await deployContract(hre, {
		deploymentName: 'NodeOperatorsRegistry',
		from: deployerSigner.address,
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'NodeOperatorsRegistry',
	})

	const steth = await deployContract(hre, {
		deploymentName: 'STETH',
		from: deployerSigner.address,
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'Lido',
		args: [
			lido_deposit.address,
			deployerSigner.address,
			lido_registry.address,
			deployerSigner.address,
			deployerSigner.address,
		],
	})

	const wsteth = await deployContract(hre, {
		deploymentName: 'WSTETH',
		from: deployerSigner.address,
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'WstETH',
		args: [steth.address],
	})

	console.log('\n Lido contracts deployed!')

	const randomBytes = hre.ethers.utils.randomBytes(32)
	const withdrawalCredentials = hre.ethers.utils.hexlify(randomBytes)
	const withdrawalCredentialsSet: boolean =
		(await hre.deployments.read('STETH', 'getWithdrawalCredentials')) ===
		hre.ethers.constants.HashZero

	if (!withdrawalCredentialsSet) {
		await hre.deployments.execute(
			'NodeOperatorsRegistry',
			{ from: deployerSigner.address, log: true },
			'setLido',
			steth.address,
		)
		await hre.deployments.execute(
			'STETH',
			{ from: deployerSigner.address, log: true },
			'setWithdrawalCredentials',
			withdrawalCredentials,
		)
	}

	const currentOracle = (await hre.deployments.read('STETH', 'getOracle')) as string
	if (currentOracle !== deployerSigner.address)
		await hre.deployments.execute(
			'STETH',
			{ from: deployerSigner.address, log: true },
			'setOracle',
			deployerSigner.address,
		)

	const currentFee = (await hre.deployments.read('STETH', 'getFee')) as string
	if (parseInt(currentFee) !== 0)
		await hre.deployments.execute('STETH', { from: deployerSigner.address, log: true }, 'setFee', 0)

	const isLidoStopped = (await hre.deployments.read('STETH', 'isStopped')) as boolean
	if (isLidoStopped)
		await hre.deployments.execute('STETH', { from: deployerSigner.address, log: true }, 'resume')

	console.log('\n Lido contracts activated!\n')
}

export default deployLido
deployLido.dependencies = []
deployLido.tags = _deployTags(['Lido'])
