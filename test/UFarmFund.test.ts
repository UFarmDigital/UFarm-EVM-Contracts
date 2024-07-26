// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { UFarmFund } from '../typechain-types/'
import { BigNumber } from 'ethers'
import { UFarmCoreFixture, UFarmFundFixture, fundWithPoolFixture } from './_fixtures'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'

import {
	deployPool,
	constants,
	bitsToBigNumber,
	_prepareInvite,
	_signWithdrawRequest,
	WithdrawRequestStruct,
	protocolToBytes32,
} from './_helpers'

describe('UFarmFund', function () {
	describe('Basic tests', function () {
		it('Should activate fund', async function () {
			const { UFarmFund_instance } = await loadFixture(UFarmFundFixture)

			expect(await UFarmFund_instance.status()).to.equal(0) // 0 = Approved

			await expect(UFarmFund_instance.changeStatus(1))
				.to.emit(UFarmFund_instance, 'FundStatusChanged')
				.withArgs(1)
		})
		it('Addresses should be correct', async function () {
			const { UFarmCore_instance, deployer, UFarmFund_instance } = await loadFixture(
				UFarmFundFixture,
			)

			expect(await UFarmFund_instance.ufarmCore()).to.equal(UFarmCore_instance.address)
			// TODO: to be continued...
		})
	})
	describe('Pools tests', function () {
		const tempSalt = () => {
			return ethers.utils.randomBytes(32)
		}
		it('Initial pool count should be 0', async function () {
			const { UFarmFund_instance } = await loadFixture(UFarmFundFixture)

			expect(await UFarmFund_instance.poolsCount()).to.equal(0)
		})
		it('Should create pool with event', async function () {
			const { alice, UFarmFund_instance, deployer, UFarmCore_instance, poolArgs } =
				await loadFixture(UFarmFundFixture)

			const salt = tempSalt()

			const [poolAddr, poolAdmin] = await UFarmFund_instance.connect(alice).callStatic.createPool(
				poolArgs,
				salt,
			)

			await expect(UFarmFund_instance.connect(alice).createPool(poolArgs, salt))
				.to.emit(UFarmFund_instance, 'PoolCreated')
				.withArgs(
					'UFarm-'.concat(await poolArgs.name),
					'UF-'.concat(await poolArgs.symbol),
					poolArgs.minInvestment,
					poolArgs.maxInvestment,
					poolArgs.managementCommission,
					poolArgs.packedPerformanceCommission,
					poolArgs.withdrawalLockupPeriod,
					0,
					poolAddr,
					poolAdmin,
				)
		})
		it('Should create pool with precalculated address', async function () {
			const { alice, UFarmFund_instance, deployer, PoolFactory_instance, poolArgs } =
				await loadFixture(UFarmFundFixture)

			const salt1 = '0x759688d05783d51759ded786fb469c3fa8cb44f910f4ec3020d7c2dbf95baaaa'
			const salt2 = '0x759688d05783d51759ded786fb469c3fa8cb44f910f4ec3020d7c2dbf95baaab'

			const nextPoolId = await UFarmFund_instance.poolsCount()

			const [poolAddr2_response, poolAdmin2_response] = await PoolFactory_instance.getPoolBySalt(salt2)
			const [poolAddr_response, poolAdmin_response] = await PoolFactory_instance.getPoolBySalt(salt1)
			
			await UFarmFund_instance.connect(alice).createPool(poolArgs, salt1)
			await UFarmFund_instance.connect(alice).createPool(poolArgs, salt2)

			const [poolAddr_actual, poolAdmin_actual] = await UFarmFund_instance.getPool(nextPoolId)
			const [poolAddr2_actual, poolAdmin2_actual] = await UFarmFund_instance.getPool(nextPoolId.add(1))

			expect(poolAddr_actual).to.eq(poolAddr_response, 'Response pool address should be correct')
			expect(poolAdmin_actual).to.eq(poolAdmin_response, 'Response pool admin should be correct')

			expect(poolAddr2_actual).to.eq(poolAddr2_response, 'Response pool address should be correct')
			expect(poolAdmin2_actual).to.eq(poolAdmin2_response, 'Response pool admin should be correct')
		})
		it('Should return all pools addresses', async function () {
			const { alice, UFarmFund_instance, deployer, UFarmCore_instance, poolArgs } =
				await loadFixture(UFarmFundFixture)

			const count = 10

			for (let i = 0; i < count; i++) {
				const tempSalt = ethers.utils.randomBytes(32)
				await UFarmFund_instance.connect(alice).createPool(poolArgs, tempSalt)
			}

			expect(await UFarmFund_instance.poolsCount()).to.equal(count)

			const poolsAddresses = await UFarmFund_instance.getPools()

			expect(poolsAddresses.length).to.equal(count)

			for (let i = 0; i < count; i++) {
				expect(poolsAddresses[i]).to.deep.eq(await UFarmFund_instance.getPool(i))
			}
		})
		it('Fund can create pools when its approved', async function () {
			const { UFarmFund_instance, poolArgs } = await loadFixture(UFarmFundFixture)

			expect(await UFarmFund_instance.status()).to.equal(0) // 0 = Approved

			await expect(UFarmFund_instance.createPool(poolArgs, tempSalt())).to.be.not.reverted
		})
		it('Fund can create pools when its active', async function () {
			const { UFarmFund_instance, poolArgs } = await loadFixture(UFarmFundFixture)

			await UFarmFund_instance.changeStatus(1) // 1 = Active

			expect(await UFarmFund_instance.status()).to.equal(1) // 1 = Active

			await expect(UFarmFund_instance.createPool(poolArgs, tempSalt())).to.be.not.reverted
		})
		it('Fund can deposit and withdraw from pools when its approved', async function () {
			const { UFarmFund_instance, poolArgs, tokens, alice } = await loadFixture(UFarmFundFixture)

			expect(await UFarmFund_instance.status()).to.equal(0) // 0 = Approved

			const newPool = await deployPool(poolArgs, UFarmFund_instance.connect(alice))

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			await expect(() =>
				UFarmFund_instance.depositToPool(newPool.pool.address, constants.ONE_HUNDRED_BUCKS),
			).to.changeTokenBalance(tokens.USDT, UFarmFund_instance, constants.ONE_HUNDRED_BUCKS.mul(-1))

			const signedWithdrawalRequest = await _signWithdrawRequest(newPool.pool, alice, {
				sharesToBurn: constants.ONE_HUNDRED_BUCKS,
				salt: protocolToBytes32('anySalt'),
				poolAddr: newPool.pool.address,
			} as WithdrawRequestStruct)

			await expect(() =>
				UFarmFund_instance.withdrawFromPool({
					body: signedWithdrawalRequest.msg,
					signature: signedWithdrawalRequest.sig,
				}),
			).to.changeTokenBalance(tokens.USDT, UFarmFund_instance, constants.ONE_HUNDRED_BUCKS)
		})
		it('Fund can deposit and withdraw from pools when its active', async function () {
			const { UFarmFund_instance, poolArgs, tokens, alice } = await loadFixture(UFarmFundFixture)

			await UFarmFund_instance.changeStatus(1) // 1 = Active

			expect(await UFarmFund_instance.status()).to.equal(1)

			const newPool = await deployPool(poolArgs, UFarmFund_instance.connect(alice))

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			await expect(() =>
				UFarmFund_instance.depositToPool(newPool.pool.address, constants.ONE_HUNDRED_BUCKS),
			).to.changeTokenBalance(tokens.USDT, UFarmFund_instance, constants.ONE_HUNDRED_BUCKS.mul(-1))

			const signedWithdrawalRequest = await _signWithdrawRequest(newPool.pool, alice, {
				sharesToBurn: constants.ONE_HUNDRED_BUCKS,
				salt: protocolToBytes32('anySalt'),
				poolAddr: newPool.pool.address,
			} as WithdrawRequestStruct)

			await expect(() =>
				UFarmFund_instance.withdrawFromPool({
					body: signedWithdrawalRequest.msg,
					signature: signedWithdrawalRequest.sig,
				}),
			).to.changeTokenBalance(tokens.USDT, UFarmFund_instance, constants.ONE_HUNDRED_BUCKS)
		})
	})
	describe('Fund Permission tests', function () {
		it('Fund member can receive new permissions via invitation', async function () {
			const { UFarmFund_instance, alice, bob, wallet, carol } = await loadFixture(
				fundWithPoolFixture,
			)

			const inviteeMask = bitsToBigNumber(
				constants.Fund.Roles.MemberRole.concat(
					constants.Fund.Roles.FundEditorRole,
					constants.Fund.Roles.AllPoolsFinanceManagerRole,
					constants.Fund.Roles.FundFinanceManagerRole,
				),
			)

			const invite = await _prepareInvite(UFarmFund_instance, alice, {
				invitee: bob.address,
				permissionsMask: inviteeMask,
			})

			type FundInvite = {
				invitation: {
					deadline: number
					invitee: string
					permissionsMask: BigNumber
				}
				signature: string
			}

			const contractInvite: FundInvite = {
				invitation: {
					deadline: invite.msg.deadline,
					invitee: invite.msg.invitee,
					permissionsMask: invite.msg.permissionsMask,
				},
				signature: invite.sig,
			}

			expect(
				await UFarmFund_instance.verifyInvitation(
					contractInvite.invitation,
					contractInvite.signature,
				),
			).to.be.not.reverted

			const invitationResponse = await UFarmFund_instance.verifyInvitation(invite.msg, invite.sig)

			expect(invitationResponse.inviter).to.eq(alice.address, 'Inviter should be correct')
			expect(invitationResponse.msgHash).to.eq(invite.hash, 'MsgHash should be correct')

			await expect(UFarmFund_instance.connect(bob).acceptInvitation(invite.msg, invite.sig))
				.to.emit(UFarmFund_instance, 'InvitationAccepted')
				.withArgs(alice.address, bob.address, invite.hash)
				.to.emit(UFarmFund_instance, 'PermissionsUpdated')
				.withArgs(bob.address, inviteeMask)
		})
		it(`Can't accept invitation with deadline in the past`, async function () {
			const { UFarmFund_instance, alice, bob, wallet, carol } = await loadFixture(
				fundWithPoolFixture,
			)

			const inviteeMask = bitsToBigNumber(
				constants.Fund.Roles.MemberRole.concat(
					constants.Fund.Roles.FundEditorRole,
					constants.Fund.Roles.AllPoolsFinanceManagerRole,
				),
			)

			const overdueDeadline = (await time.latest()) - time.duration.days(1)

			const invite = await _prepareInvite(UFarmFund_instance, alice, {
				invitee: bob.address,
				permissionsMask: inviteeMask,
				deadline: overdueDeadline,
			})

			await expect(UFarmFund_instance.connect(bob).acceptInvitation(invite.msg, invite.sig))
				.to.be.revertedWithCustomError(UFarmFund_instance, 'InvitationExpired')
				.withArgs(overdueDeadline, (await time.latest()) + 1)
		})
		it(`Current member can't accept invitation`, async function () {
			const { UFarmFund_instance, alice, bob, wallet, carol } = await loadFixture(
				fundWithPoolFixture,
			)

			const mask1 = bitsToBigNumber(
				constants.Fund.Roles.MemberRole.concat(
					constants.Fund.Roles.FundEditorRole,
					constants.Fund.Roles.AllPoolsFinanceManagerRole,
				),
			)

			const mask2 = bitsToBigNumber(
				constants.Fund.Roles.MemberRole.concat(
					constants.Fund.Roles.FundEditorRole,
					constants.Fund.Roles.FundFinanceManagerRole,
				),
			)

			const invite1 = await _prepareInvite(UFarmFund_instance, alice, {
				invitee: carol.address,
				permissionsMask: mask1,
			})

			const invite2 = await _prepareInvite(UFarmFund_instance, alice, {
				invitee: carol.address,
				permissionsMask: mask2,
			})

			await UFarmFund_instance.connect(carol).acceptInvitation(invite1.msg, invite1.sig)

			await expect(
				UFarmFund_instance.connect(carol).acceptInvitation(invite2.msg, invite2.sig),
			).to.be.revertedWithCustomError(UFarmFund_instance, 'AlreadyMember')
		})

		it(`Invite can't be used twice`, async function () {
			const { UFarmFund_instance, alice, bob, wallet, carol } = await loadFixture(
				fundWithPoolFixture,
			)

			const inviteeMask = bitsToBigNumber(
				constants.Fund.Roles.MemberRole.concat(
					constants.Fund.Roles.FundEditorRole,
					constants.Fund.Roles.AllPoolsFinanceManagerRole,
				),
			)

			const invite = await _prepareInvite(UFarmFund_instance, alice, {
				invitee: bob.address,
				permissionsMask: inviteeMask,
			})

			// submit invitation
			await UFarmFund_instance.connect(bob).acceptInvitation(invite.msg, invite.sig)

			// revert permission update
			await UFarmFund_instance.connect(alice).updatePermissions(bob.address, BigNumber.from(0))

			// try to submit invitation again
			await expect(
				UFarmFund_instance.connect(bob).acceptInvitation(invite.msg, invite.sig),
			).to.be.revertedWithCustomError(UFarmFund_instance, 'ActionAlreadyDone')
		})
		it("Many users can be owners, last owner can't be removed", async function () {
			const { UFarmFund_instance, alice, bob, wallet, carol } = await loadFixture(
				fundWithPoolFixture,
			)

			const ownerMask = bitsToBigNumber([constants.Fund.Permissions.Owner])

			await expect(UFarmFund_instance.updatePermissions(bob.address, ownerMask))
				.to.emit(UFarmFund_instance, 'PermissionsUpdated')
				.withArgs(bob.address, ownerMask)

			await expect(UFarmFund_instance.updatePermissions(wallet.address, ownerMask))
				.to.emit(UFarmFund_instance, 'PermissionsUpdated')
				.withArgs(wallet.address, ownerMask)

			const permissionsArray = Array.from(Object.values(constants.Fund.Permissions))
			const emptyPermissionsArray = Array.from({ length: permissionsArray.length }, () => 0)
			const emptyPermissionsMask = bitsToBigNumber(emptyPermissionsArray)

			await expect(
				UFarmFund_instance.connect(carol).updatePermissions(carol.address, emptyPermissionsMask),
			).to.be.revertedWithCustomError(UFarmFund_instance, 'NonAuthorized')

			await UFarmFund_instance.updatePermissions(carol.address, ownerMask)

			await expect(UFarmFund_instance.updatePermissions(wallet.address, emptyPermissionsMask))
				.to.emit(UFarmFund_instance, 'PermissionsUpdated')
				.withArgs(wallet.address, emptyPermissionsMask)

			await expect(UFarmFund_instance.updatePermissions(bob.address, emptyPermissionsMask))
				.to.emit(UFarmFund_instance, 'PermissionsUpdated')
				.withArgs(bob.address, emptyPermissionsMask)

			await expect(
				UFarmFund_instance.updatePermissions(alice.address, emptyPermissionsMask),
			).to.be.revertedWithCustomError(UFarmFund_instance, 'NonAuthorized')

			await UFarmFund_instance.connect(carol).updatePermissions(alice.address, emptyPermissionsMask)

			await expect(
				UFarmFund_instance.connect(carol).updatePermissions(carol.address, emptyPermissionsMask),
			).to.be.revertedWithCustomError(UFarmFund_instance, 'NonAuthorized')
		})
	})

	describe("Fund assets balance operations' tests", function () {
		it('Should receive and transfer ERC20 tokens', async function () {
			const { UFarmFund_instance, deployer, alice, tokens } = await loadFixture(UFarmFundFixture)

			const token = tokens.DAI

			const transferableAmount = ethers.utils.parseEther('100')

			await token.mint(deployer.address, transferableAmount.mul(2))
			await token.connect(deployer).transfer(UFarmFund_instance.address, transferableAmount)

			expect(await token.balanceOf(UFarmFund_instance.address)).to.eq(
				transferableAmount,
				"Fund should keep tokens in it's balance",
			)

			await expect(() =>
				UFarmFund_instance.connect(alice).withdrawAsset(
					token.address,
					deployer.address,
					transferableAmount,
				),
			).to.changeTokenBalance(token, deployer, transferableAmount)
		})
	})
})
