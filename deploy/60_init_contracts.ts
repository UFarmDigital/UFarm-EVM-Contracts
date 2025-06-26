// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	getInstanceFromDeployment,
	retryOperation,
	getPriceOracleContract,
	_deployTags,
	getNetworkType,
} from '../scripts/_deploy_helpers'
import { FundFactory, PoolFactory, PriceOracle, QuexCore, UFarmCore } from '../typechain-types'

const initContracts: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)
	const AddressZero = hre.ethers.constants.AddressZero

	const priceOracle_instance = (
		getInstanceFromDeployment<PriceOracle>(hre, await hre.deployments.get('PriceOracle'))
	).connect(deployerSigner)

	const ufarmCore_instance = (
		getInstanceFromDeployment<UFarmCore>(hre, await hre.deployments.get('UFarmCore'))
	).connect(deployerSigner)

	const fundFactory_instance = (
		getInstanceFromDeployment<FundFactory>(hre, await hre.deployments.get('FundFactory'))
	).connect(deployerSigner)

	const poolFactory_instance = (
		getInstanceFromDeployment<PoolFactory>(hre, await hre.deployments.get('PoolFactory'))
	).connect(deployerSigner)

	const quexCore_instance = isTestnet(hre.network) ? (
		getInstanceFromDeployment<QuexCore>(hre, await hre.deployments.get('QuexCore'))
	).connect(deployerSigner) : null

	console.log('\nInitializing contracts...')
	const thisNetworkPriceOracle = getPriceOracleContract(hre.network)

	if ((await ufarmCore_instance.priceOracle()) !== priceOracle_instance.address) {
		console.log('Initializing PriceOracle...')

		const args = [ufarmCore_instance.address].concat(
			thisNetworkPriceOracle.args.map((arg) => 
				arg._quexCore || quexCore_instance?.address || AddressZero
			),
		)
		console.log('args:', args)

		await retryOperation(async () => {
			await hre.deployments.execute(
				'PriceOracle',
				{
					from: deployerSigner.address,
					log: true,
				},
				thisNetworkPriceOracle.initFunc,
				...args,
			)
		}, 3)

		console.log('PriceOracle initialized!')
	} else {
		console.log('PriceOracle already initialized!')
	}

	if (await priceOracle_instance.quexCore() === AddressZero) {
		console.log('Setting QuexCore at PriceOracle...')

		await retryOperation(async () => {
			await hre.deployments.execute(
				'PriceOracle',
				{
					from: deployerSigner.address,
					log: true,
				},
				'setQuexCore',
				thisNetworkPriceOracle.args.map((arg) =>
					arg._quexCore || quexCore_instance?.address || AddressZero
				),
			)
		}, 3)

		console.log('QuexCore configured!')
	} else {
		console.log('QuexCore already set!')
	}

	const [fundAddr, poolAddr, priceOracleAddr] = await Promise.all([
		ufarmCore_instance.fundFactory(),
		ufarmCore_instance.poolFactory(),
		ufarmCore_instance.priceOracle(),
	])

	// if any of that addresses is not set, we need to initialize UFarmCore
	if (fundAddr === AddressZero || poolAddr === AddressZero || priceOracleAddr === AddressZero) {
		console.log('Initializing UFarmCore...')

		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'__init__UFarmCore',
				deployerSigner.address,
				fundFactory_instance.address,
				poolFactory_instance.address,
				priceOracle_instance.address,
			)
		}, 3)

		console.log('UFarmCore initialized!')
	} else {
		console.log('UFarmCore already initialized!')
	}

	console.log('\nAll contracts initialized!')
}

export default initContracts
initContracts.dependencies = ['PriceOracle', 'UFarmCore', 'FundFactory', 'PoolFactory', 'QuexCore']
initContracts.tags = _deployTags(['InitializeUFarm'])
