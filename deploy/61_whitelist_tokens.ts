// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { _deployTags, whitelistTokensWithAggregator, isMainnet, whitelistValueTokens, isTestnet } from '../scripts/_deploy_helpers'
import { AggregatorV2V3Interface, UFarmMockV3Aggregator } from '../typechain-types'

const whitelistTokens: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (isTestnet(hre.network)) {
		await whitelistTokensWithAggregator<UFarmMockV3Aggregator>(hre)
	}

	await whitelistValueTokens(hre)
}

export default whitelistTokens
whitelistTokens.dependencies = _deployTags(['InitializeUFarm', 'MockedAggregators', 'WstETHOracle'])
whitelistTokens.tags = _deployTags(['WhiteListTokens'])
