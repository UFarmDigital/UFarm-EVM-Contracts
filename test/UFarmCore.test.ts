// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { time, loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import { UFarmFund } from '../typechain-types/'

import { UFarmCoreFixture } from './_fixtures'

import {
	protocolToBytes32,
	constants,
	getEventFromTx,
	AssetWithPriceFeed,
	FeedWithDecimal,
} from './_helpers'
import { bitsToBigNumber } from './_helpers'

describe('UFarmCore test', function () {
	describe('Basic tests', function () {
		it('Should create fund', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			const firstFundId = 0
			const applicationId = ethers.utils.randomBytes(32)

			expect(await UFarmCore_instance.connect(deployer).createFund(deployer.address, applicationId))
				.to.emit(UFarmCore_instance, 'FundCreated')
				.withArgs(applicationId, firstFundId, anyValue)

			const address_UFarmFund = await UFarmCore_instance.getFund(firstFundId)

			const UFarmFund_instance: UFarmFund = await ethers.getContractAt(
				'UFarmFund',
				address_UFarmFund,
				alice,
			)

			expect(await UFarmFund_instance.name()).to.equal('UFarmFund')
		})

		it('Should create the same fund with same applicationId', async function () {
			const { UFarmCore_instance, FundFactory_instance, deployer, alice, bob } = await loadFixture(
				UFarmCoreFixture,
			)

			const applications = [
				{
					id: ethers.utils.randomBytes(32),
					admin: alice.address,
				},
				{
					id: ethers.utils.randomBytes(32),
					admin: deployer.address,
				},
				{
					id: ethers.utils.randomBytes(32),
					admin: bob.address,
				},
			]
			const reversedApplications = applications.reverse()
			
			const cleanSnapshot = await takeSnapshot()

			const funds1 = []

			for (const application of applications) {
				const fundAddr = await FundFactory_instance.getFundBySalt(application.admin, application.id)

				expect(
					await UFarmCore_instance.connect(deployer).createFund(application.admin, application.id),
				)
					.to.emit(UFarmCore_instance, 'FundCreated')
					.withArgs(application.id, anyValue, fundAddr)

				funds1.push(fundAddr)
			}

			await cleanSnapshot.restore()

			const funds2 = []
			
			for (const application of reversedApplications) {
				const fundAddr = await FundFactory_instance.getFundBySalt(application.admin, application.id)

				expect(
					await UFarmCore_instance.connect(deployer).createFund(application.admin, application.id),
				)
					.to.emit(UFarmCore_instance, 'FundCreated')
					.withArgs(application.id, anyValue, fundAddr)

				funds2.push(fundAddr)
			}
			expect(funds1).to.deep.equal(funds2, 'Funds are not the same')
		})
	})
	describe('UFarm Permission tests', function () {
		it('Should deploy contract and grant permissions to the admin', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			for (const [key, value] of Object.entries(constants.UFarm.Permissions)) {
				expect(await UFarmCore_instance.hasPermission(deployer.address, value)).to.equal(
					true,
					`Deployer doesn't have permission ${key}`,
				)
			}
		})
		it('Should grant UFarm owner', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			expect(await UFarmCore_instance.hasPermission(alice.address, 2)).to.equal(
				false,
				'Alice is already UFarm owner',
			)

			const ownerMask = bitsToBigNumber([constants.UFarm.Permissions.Owner])

			await expect(UFarmCore_instance.connect(deployer).updatePermissions(alice.address, ownerMask))
				.to.emit(UFarmCore_instance, 'PermissionsUpdated')
				.withArgs(alice.address, ownerMask)

			expect(
				await UFarmCore_instance.hasPermission(alice.address, constants.UFarm.Permissions.Owner),
			).to.equal(true, 'Alice is not UFarm owner')
		})
		it('Should grant and remove UFarm permission', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			expect(
				await UFarmCore_instance.hasPermission(alice.address, constants.UFarm.Permissions.Member),
			).to.equal(false, 'Alice is already UFarm member')
			expect(
				await UFarmCore_instance.hasPermission(
					alice.address,
					constants.UFarm.Permissions.UpdatePermissions,
				),
			).to.equal(false, 'Alice already has UpdatePermissions permission')

			const memberBlockFundMask = bitsToBigNumber([
				constants.UFarm.Permissions.Member,
				constants.UFarm.Permissions.BlockFund,
			])

			await expect(
				UFarmCore_instance.connect(deployer).updatePermissions(alice.address, memberBlockFundMask),
			)
				.to.emit(UFarmCore_instance, 'PermissionsUpdated')
				.withArgs(alice.address, memberBlockFundMask)

			expect(
				await UFarmCore_instance.hasPermission(alice.address, constants.UFarm.Permissions.Member),
			).to.equal(true, 'Alice is not UFarm member')
			expect(
				await UFarmCore_instance.hasPermission(
					alice.address,
					constants.UFarm.Permissions.BlockFund,
				),
			).to.equal(true, 'Alice does not have BlockFund permission')

			const multiMask = bitsToBigNumber([
				constants.UFarm.Permissions.Member,
				constants.UFarm.Permissions.UpdateUFarmMember,
				constants.UFarm.Permissions.TurnPauseOn,
			])

			await expect(UFarmCore_instance.connect(deployer).updatePermissions(alice.address, multiMask))
				.to.emit(UFarmCore_instance, 'PermissionsUpdated')
				.withArgs(alice.address, multiMask)

			expect(
				await UFarmCore_instance.hasPermission(alice.address, constants.UFarm.Permissions.Member),
			).to.equal(true)
			expect(
				await UFarmCore_instance.hasPermission(
					alice.address,
					constants.UFarm.Permissions.BlockFund,
				),
			).to.equal(false)
			expect(
				await UFarmCore_instance.hasPermission(
					alice.address,
					constants.UFarm.Permissions.TurnPauseOn,
				),
			).to.equal(true)
		})
		it('Should deploy with one owner', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			expect(
				await UFarmCore_instance.hasPermission(deployer.address, constants.UFarm.Permissions.Owner),
			).to.equal(true)
			expect(
				await UFarmCore_instance.hasPermission(bob.address, constants.UFarm.Permissions.Owner),
			).to.equal(false)
		})
		it('Only owner can grant ownership', async function () {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			// Bob is not member
			expect(
				await UFarmCore_instance.hasPermission(bob.address, constants.UFarm.Permissions.Owner),
			).to.equal(false, 'Bob is not UFarm owner')

			// Bob can't grant ownership to anyone
			const ownerMask = bitsToBigNumber([constants.UFarm.Permissions.Owner])

			await expect(
				UFarmCore_instance.connect(bob).updatePermissions(alice.address, ownerMask),
			).to.be.revertedWithCustomError(UFarmCore_instance, 'NonAuthorized')
			await expect(
				UFarmCore_instance.connect(bob).updatePermissions(bob.address, ownerMask),
			).to.be.revertedWithCustomError(UFarmCore_instance, 'NonAuthorized')

			// Grant member role to Bob
			await UFarmCore_instance.updatePermissions(
				bob.address,
				bitsToBigNumber([constants.UFarm.Permissions.Member]),
			)

			// Bob is member
			await expect(
				UFarmCore_instance.connect(bob).updatePermissions(alice.address, ownerMask),
			).to.be.revertedWithCustomError(UFarmCore_instance, 'NonAuthorized')
			await expect(
				UFarmCore_instance.connect(bob).updatePermissions(bob.address, ownerMask),
			).to.be.revertedWithCustomError(UFarmCore_instance, 'NonAuthorized')

			// Grant owner role to Bob
			await UFarmCore_instance.updatePermissions(bob.address, ownerMask)

			await expect(UFarmCore_instance.connect(bob).updatePermissions(alice.address, ownerMask)).to
				.be.not.reverted
		})
	})

	describe('Token whitelist tests', function () {
		function convertToEventLogFormat(
			asset: AssetWithPriceFeed,
		): (string | number | FeedWithDecimal)[] & { assetInfo: AssetWithPriceFeed } {
			// Construct the priceFeed array with both indexed and named properties
			const priceFeedArray = [asset.priceFeed.feedAddr, asset.priceFeed.feedDec] as (
				| string
				| number
			)[] &
				FeedWithDecimal
			priceFeedArray.feedAddr = asset.priceFeed.feedAddr
			priceFeedArray.feedDec = asset.priceFeed.feedDec

			// Construct the result array with both indexed and named properties
			const resultArray = [asset.assetAddr, asset.assetDec, priceFeedArray] as (
				| string
				| number
				| typeof priceFeedArray
			)[] &
				AssetWithPriceFeed
			resultArray.assetAddr = asset.assetAddr
			resultArray.assetDec = asset.assetDec
			resultArray.priceFeed = priceFeedArray

			const finalOutput = [resultArray] as unknown as (string | number | FeedWithDecimal)[] & {
				assetInfo: AssetWithPriceFeed
			}
			finalOutput.assetInfo = resultArray

			return finalOutput
		}

		it('Should add tokens to whitelist with event', async function () {
			const { UFarmCore_instance, tokenFeeds } = await loadFixture(UFarmCoreFixture)

			const feed0 = tokenFeeds[0]
			const feed1 = tokenFeeds[1]
			const feed2 = tokenFeeds[2]

			const thisBlock = await ethers.provider.getBlock('latest')

			await UFarmCore_instance.whitelistTokens([feed0])
			await UFarmCore_instance.whitelistTokens([feed1, feed2])

			const tokenAddedFilter = UFarmCore_instance.filters.TokenAdded()
			const events = await UFarmCore_instance.queryFilter(tokenAddedFilter, thisBlock.number)

			for (let i = 0; i < events.length; i++) {
				expect(events[i].args).to.deep.equal(convertToEventLogFormat(tokenFeeds[i]))
			}
		})
		it('Should remove token from whitelist', async function () {
			const { UFarmCore_instance, tokenFeeds } = await loadFixture(UFarmCoreFixture)

			const feed0 = tokenFeeds[0]

			await UFarmCore_instance.whitelistTokens([feed0])

			await expect(UFarmCore_instance.blacklistTokens([feed0.assetAddr]))
				.to.emit(UFarmCore_instance, 'TokenRemoved')
				.withArgs(feed0.assetAddr)
		})
	})
	describe('Protocol Whitelist tests', () => {
		it('Should add protocol to whitelist', async () => {
			const { UFarmCore_instance, deployer, alice, bob } = await loadFixture(UFarmCoreFixture)

			const protocolName = protocolToBytes32('protocolName')

			expect(await UFarmCore_instance.isProtocolWhitelisted(protocolName)).to.equal(false)

			await expect(
				UFarmCore_instance.whitelistProtocolsWithControllers([protocolName], [deployer.address]),
			)
				.to.emit(UFarmCore_instance, 'ProtocolAdded')
				.withArgs(protocolName, deployer.address)

			expect(await UFarmCore_instance.isProtocolWhitelisted(protocolName)).to.equal(true)
		})
	})

	describe("Parameters' tests", function () {
		it('Should change minimumFundDeposit', async function () {
			const { UFarmCore_instance } = await loadFixture(UFarmCoreFixture)

			expect(await UFarmCore_instance.minimumFundDeposit()).to.equal(0)

			await expect(UFarmCore_instance.setMinimumFundDeposit(100))
				.to.emit(UFarmCore_instance, 'MinimumFundDepositChanged')
				.withArgs(100)

			expect(await UFarmCore_instance.minimumFundDeposit()).to.equal(100)
		})
	})
})
