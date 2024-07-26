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
	it('Price oracle getCostERC20() function test', async () => {
		const { feedInstancesTokenToUSDT, tokens, PriceOracle_instance } = await loadFixture(
			UFarmFundFixture,
		)
		const [daiPrice, daiFeedDecimals, usdtDecimals] = await Promise.all([
			feedInstancesTokenToUSDT.DAI.latestAnswer(),
			feedInstancesTokenToUSDT.DAI.decimals(),
			tokens.USDT.decimals(),
		])
		const daiCost = await PriceOracle_instance.getCostERC20(
			tokens.DAI.address,
			constants.ONE,
			tokens.USDT.address,
		)
		expect(daiCost).to.eq(
			convertDecimals(daiPrice, daiFeedDecimals, usdtDecimals),
			'DAI cost should be equal to price for 1 DAI in USDT',
		)

		const [wethPrice, wethFeedDecimals] = await Promise.all([
			feedInstancesTokenToUSDT.WETH.latestAnswer(),
			feedInstancesTokenToUSDT.WETH.decimals(),
		])
		const wethCost = await PriceOracle_instance.getCostERC20(
			tokens.WETH.address,
			constants.ONE,
			tokens.USDT.address,
		)
		expect(wethCost).to.eq(
			convertDecimals(wethPrice, wethFeedDecimals, usdtDecimals),
			'WETH cost should be equal to price for 1 WETH in USDT',
		)
	})
	it("Should check wsteth/eth oracle calculations", async () => {
		
	})
})
