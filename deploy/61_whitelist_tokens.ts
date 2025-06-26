// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { _deployTags, whitelistTokensWithAggregator, isMainnet, whitelistValueTokens } from '../scripts/_deploy_helpers'
import { AggregatorV2V3Interface, UFarmMockV3Aggregator } from '../typechain-types'

const whitelistTokens: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (isMainnet(hre.network)) {
		await whitelistTokensWithAggregator<AggregatorV2V3Interface>(hre)
	} else {
		await whitelistTokensWithAggregator<UFarmMockV3Aggregator>(hre)
	}

	await whitelistValueTokens(hre)
}

export default whitelistTokens
whitelistTokens.dependencies = _deployTags(['InitializeUFarm', 'MockedAggregators', 'WstETHOracle'])
whitelistTokens.tags = _deployTags(['WhiteListTokens'])
