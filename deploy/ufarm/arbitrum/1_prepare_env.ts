// SPDX-License-Identifier: BUSL-1.1

import { ArtifactData, DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	getStaticConfig,
	trySaveDeployment,
	NetworkTypes,
	getNetworkType,
	_deployTags,
} from '../../../scripts/_deploy_helpers'

const prepareEnv: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (isTestnet(hre.network)) {
		console.log('Skipping tokens parsing on testnet')
		return
	}
	const deployerSigner = await getDeployerSigner(hre)

	// prepare tokens
	const networkType = getNetworkType(hre.network)
	const addressField : string = networkType
	if (networkType !== NetworkTypes.Arbitrum && networkType !== NetworkTypes.Ethereum) {
		throw new Error(`This script is not meant to be run on this network: ${hre.network.name}`)
	}

	const staticConfig = await getStaticConfig(addressField)

	const pendingTokens = staticConfig.tokens

	for (const token of pendingTokens) {
		const tokenRawName = token.ticker.toUpperCase()
		const tokenAddress = token[addressField]

		if (!tokenAddress || tokenAddress === '') {
			console.log(`Token ${tokenRawName} does not have address for ${addressField}, skipping`)
			continue
		}

		await trySaveDeployment(
			tokenRawName,
			{
				from: deployerSigner.address,
				address: tokenAddress,
				contract: '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
				deploymentName: tokenRawName,
			},
			hre,
		)
	}
}

// export default prepareEnv
prepareEnv.dependencies = _deployTags([])
prepareEnv.tags = _deployTags(['PrepareEnvARB'])
export default prepareEnv
