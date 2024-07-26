// SPDX-License-Identifier: BUSL-1.1

import { ArtifactData, DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	getStaticConfig,
	trySaveDeployment,
	mockedAggregatorName,
	_deployTags,
} from '../../../scripts/_deploy_helpers'

const prepareEnv: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (isTestnet(hre.network)) {
		console.log('Skipping tokens parsing on testnet')
		return
	}
	const deployerSigner = await getDeployerSigner(hre)

	// prepare tokens

	const staticConfig = await getStaticConfig()

	const pendingTokens = staticConfig.tokens

	for (const token of pendingTokens) {
		const tokenRawName = token.ticker.toUpperCase()

		await trySaveDeployment(
			tokenRawName,
			{
				from: deployerSigner.address,
				address: token.address_chain_42161,
				contract: '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
				deploymentName: tokenRawName,
			},
			hre,
		)
	}

	const pendingAggregators = staticConfig.oracles

	for (const oracle of pendingAggregators) {
		const oracleRawName = mockedAggregatorName(oracle.ticker, hre.network)

		await trySaveDeployment(
			oracleRawName,
			{
				from: deployerSigner.address,
				address: oracle.address_chain_42161,
				contract: 'AggregatorV2V3Interface',
				deploymentName: oracleRawName,
			},
			hre,
		)
	}
	
	const pendingProtocols = staticConfig.protocols

	for (const protocol of pendingProtocols) {
		const protocolRawName = protocol.name

		await trySaveDeployment(
			protocolRawName,
			{
				from: deployerSigner.address,
				address: protocol.address_chain_42161,
				contract: protocol.abi,
				deploymentName: protocolRawName,
			},
			hre,
		)
	}
}

// export default prepareEnv
prepareEnv.dependencies = _deployTags([])
prepareEnv.tags = _deployTags(['PrepareEnvARB'])
export default prepareEnv


