// SPDX-License-Identifier: UNLICENSED

import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import {
	constants,
	_signDepositRequest,
	_signWithdrawRequest,
	convertDecimals,
} from './_helpers'
import {
	UFarmFundFixture,
	_poolSwapUniV2,
	MockedAggregatorFixture,
} from './_fixtures'
import {
	_BNsqrt,
} from './_helpers'

describe('PriceOracle', async () => {
	it('Mocked aggregator test', async () => {
		const { feedInstancesTokenToUSDT } = await loadFixture(MockedAggregatorFixture)

		const daiPrice = await feedInstancesTokenToUSDT.DAI.latestAnswer()
		const daiFeedDecimals = await feedInstancesTokenToUSDT.DAI.decimals()
		expect(daiPrice).to.be.lessThanOrEqual(
			(10n ** BigInt(daiFeedDecimals) * 105n) / 100n,
			'DAI price is too high',
		)
		expect(daiPrice).to.be.greaterThanOrEqual(
			(10n ** BigInt(daiFeedDecimals) * 95n) / 100n,
			'DAI price is too low',
		)

		const wethPrice = await feedInstancesTokenToUSDT.WETH.latestAnswer()
		const wethFeedDecimals = await feedInstancesTokenToUSDT.WETH.decimals()
		expect(wethPrice).to.be.lessThanOrEqual(
			(1800n * 10n ** BigInt(wethFeedDecimals) * 105n) / 100n,
			'WETH price is too high',
		)
		expect(wethPrice).to.be.greaterThanOrEqual(
			(1800n * 10n ** BigInt(wethFeedDecimals) * 95n) / 100n,
			'WETH price is too low',
		)
	})
	it("Should check wsteth/eth oracle calculations", async () => {
		
	})
})
