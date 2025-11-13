// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	mockedAggregatorName,
	_deployTags,
	deployUpgradedContract,
	retryOperation,
	replaceUpdatedContract,
} from '../scripts/_deploy_helpers'

const deployWstETHOracle: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)) {
		console.log('Skipping WstETHOracle deployment')
		return
	}

	const deployerSigner = await getDeployerSigner(hre)

	console.log('\nDeploying WstETHOracle...')

	const wsteth_deployment = await hre.deployments.get('WSTETH')
	const stethUSD_oracle_deployment = await hre.deployments.get(
		mockedAggregatorName('STETH', hre.network),
	)
	const LidoRateOracle = await hre.deployments.get('LidoRateOracle')

	const wstethOracleDeployments = await deployUpgradedContract(hre, {
		deploymentName: 'WSTETHOracle',
		from: deployerSigner.address,
		args: [wsteth_deployment.address, stethUSD_oracle_deployment.address, LidoRateOracle.address],
		log: true,
		skipIfAlreadyDeployed: true,
		contract: 'WstETHOracle',
	})

	const ufarmCore_deployment = await hre.deployments.getOrNull('UFarmCore')

	if (ufarmCore_deployment) {
		if (wstethOracleDeployments.newDeployment) {
			const ufarmCore_instance = await hre.ethers.getContractAt(
				'UFarmCore',
				ufarmCore_deployment.address,
				deployerSigner,
			)
			const existingWstETHOracle = await ufarmCore_instance.tokenInfo(wsteth_deployment.address)
			// if new oracle is deployed, update it in UFarmCore
			if (
				existingWstETHOracle.priceFeed.feedAddr !== wstethOracleDeployments.newDeployment.address
			) {
				if (existingWstETHOracle.priceFeed.feedAddr !== hre.ethers.constants.AddressZero) {
					console.log(`Removing WstETHOracle from UFarmCore...`)
					await retryOperation(async () => {
						await ufarmCore_instance.blacklistTokens([wsteth_deployment.address])
					}, 3)
					console.log(`WstETH blacklisted in UFarmCore.`)
					await replaceUpdatedContract(hre, 'WSTETHOracle')
				} else {
					console.log('WstETH is not whitelisted in UFarmCore yet.')
				}
			}
		}
	}
}

export default deployWstETHOracle
deployWstETHOracle.dependencies = _deployTags(['MockedAggregators'])
deployWstETHOracle.tags = _deployTags(['WstETHOracle'])
