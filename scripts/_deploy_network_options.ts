// SPDX-License-Identifier: UNLICENSED

import { Network } from 'hardhat/types'
import { getNetworkType } from './_deploy_helpers'

export const initOptsUniV2: Record<
	string,
	{
		codeHash: string
		controller: string
	}
> = {
	arbitrum: {
		codeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
		controller: 'UniswapV2ControllerArbitrum',
	},
}

export const initOptsUniV3: Record<
	string,
	{
		codeHash: string
		controller: string
	}
> = {
	arbitrum: {
		codeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
		controller: 'UniswapV3ControllerArbitrum',
	},
}

export const getInitCodeUniV2 = (network: Network) => {
	const networkType = getNetworkType(network)
	if (networkType === 'arbitrum') {
		return initOptsUniV2.arbitrum
	} else {
		throw new Error(`Init code not found for network: ${network.name} with tags: ${network.tags}`)
	}
}

export const getInitCodeUniV3 = (network: Network) => {
	const networkType = getNetworkType(network)

	if (networkType === 'arbitrum') {
		return initOptsUniV3.arbitrum
	} else {
		throw new Error(`Init code not found for network: ${network.name} with tags: ${network.tags}`)
	}
}
