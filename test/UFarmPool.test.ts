// SPDX-License-Identifier: UNLICENSED

import { ethers, upgrades, deployments } from 'hardhat'
import * as hre from 'hardhat'
import { expect } from 'chai'
import {
	time,
	loadFixture,
	takeSnapshot,
	impersonateAccount,
} from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { BigNumberish, BigNumber, ContractTransaction } from 'ethers'
import {
	Block__factory,
	INonfungiblePositionManager,
	IUniswapV2Pair,
	IUniswapV3Pool,
	MockPoolAdmin,
	MockPoolAdmin__factory,
	MockUFarmPool__factory,
	MockV3wstETHstETHAgg,
	OneInchToUfarmTestEnv,
	OneInchV5Controller__factory,
	PriceOracle,
	QuexCore,
	StableCoin,
	UFarmCore,
	UFarmFund,
	UFarmPool,
	UnoswapV2Controller,
	UUPSBlock__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
	Pool,
	TickMath,
	nearestUsableTick,
	Position,
	maxLiquidityForAmounts,
} from '@uniswap/v3-sdk'
import {
	nullClientVerification,
	mintAndDeposit,
	getEventFromReceipt,
	getEventFromTx,
	encodePoolSwapDataUniswapV2,
	encodePoolAddLiqudityDataAsIsUniswapV2,
	encodePoolRemoveLiquidityUniswapV2,
	uniV3_tokensFeesToPath,
	encodePoolSwapUniV3SingleHopExactInput,
	encodePoolSwapUniV3MultiHopExactInput,
	twoPercentLose,
	constants,
	encodePoolOneInchSwap,
	encodePoolMintPositionUniV3,
	encodeBurnPositionUniV3,
	_signDepositRequest,
	DepositRequestStruct,
	WithdrawRequestStruct,
	_signWithdrawRequest,
	SignedWithdrawRequestStruct,
	getEventsFromReceiptByEventName,
	convertDecimals,
	encodePoolAddLiqudityDataUniswapV2,
	prepareWithdrawRequest,
	quoteMaxSlippageSingle,
	getBlockchainTimestamp,
	oneInchCustomUnoswap,
	packPerformanceCommission,
	toBigInt,
	unpackPerformanceCommission,
	encodeCollectFeesUniV3,
	mintTokens,
	safeApprove,
	get1InchResult,
	encodePoolOneInchMultiSwap,
	getEventsFromTx,
} from './_helpers'
import {
	ETHPoolFixture,
	fundWithPoolFixture,
	getPriceRate,
	UFarmFundFixture,
	executeAndGetTimestamp,
	blankPoolWithRatesFixture,
	_poolSwapUniV2,
} from './_fixtures'
import {
	setExchangeRate,
	deployPool,
	oneInchCustomUnoswapTo,
	protocolToBytes32,
	_BNsqrt,
	bitsToBigNumber,
	PoolCreationStruct,
} from './_helpers'
import {
	getDeployerSigner,
	getInstanceOfDeployed,
	getSignersByNames,
	trySaveDeployment,
} from '../scripts/_deploy_helpers'
import { HTTPRequestStruct } from '../typechain-types/contracts/test/Quex/QuexPool'

describe('UFarmPool test', function () {
	describe('Basic tests', function () {
		describe('Beacon UUPS update tests', function () {
			it('UFarmPool can be updated', async function () {
				const {
					deployer,
					bob,
					Pool_beacon,
					Pool_implementation_factory,
					initialized_pool_instance,
				} = await loadFixture(fundWithPoolFixture)

				expect(
					await (
						await ethers.getContractAt(
							'@oldzeppelin/contracts/access/Ownable.sol:Ownable',
							initialized_pool_instance.pool.address,
						)
					).owner(),
				).to.eq(ethers.constants.AddressZero, 'Beacon should be permissionless')

				expect(
					await (
						await ethers.getContractAt(
							'@oldzeppelin/contracts/access/Ownable.sol:Ownable',
							Pool_beacon.address,
						)
					).owner(),
				).to.eq(deployer.address, 'Beacon should be owned by deployer')

				const mockPoolFactory = (await ethers.getContractFactory(
					'MockUFarmPool',
				)) as MockUFarmPool__factory

				const mockPoolImpl = await mockPoolFactory.deploy()
				const poolImpl = await Pool_implementation_factory.deploy()

				const upgradedPool = mockPoolFactory.attach(initialized_pool_instance.pool.address)

				await expect(upgradedPool.getBlockTimestamp()).to.be.reverted

				await expect(
					initialized_pool_instance.pool.upgradeTo(initialized_pool_instance.pool.address),
				).to.be.reverted

				await expect(Pool_beacon.connect(bob).upgradeTo(mockPoolImpl.address)).to.be.revertedWith(
					'Ownable: caller is not the owner',
				)

				await upgrades.upgradeBeacon(Pool_beacon.address, mockPoolFactory, {})
				await expect(upgradedPool.getBlockTimestamp()).to.be.not.reverted

				await Pool_beacon.connect(deployer).transferOwnership(bob.address)

				await expect(Pool_beacon.connect(deployer).upgradeTo(poolImpl.address)).to.be.reverted
				await expect(Pool_beacon.connect(bob).upgradeTo(poolImpl.address)).to.be.not.reverted
				await expect(upgradedPool.getBlockTimestamp()).to.be.reverted
			})
			it(`UFarmPool implementation can't be initialized`, async function () {
				const {
					deployer,
					bob,
					Pool_beacon,
					Pool_implementation_factory,
					initialized_pool_instance,
					UFarmFund_instance,
					emptyPoolArgs,
				} = await loadFixture(fundWithPoolFixture)

				const realAddr = deployer.address

				const fakeInitPoolCallStruct = {
					params: {
						minInvestment: 0,
						maxInvestment: 0,
						managementCommission: 0,
						packedPerformanceCommission: 0,
						withdrawalLockupPeriod: 0,
						valueToken: realAddr,
						staff: [],
						name: 'Pool name',
						symbol: 'Pool symbol',
					},
					ufarmCore: realAddr,
					ufarmFund: realAddr,
				}

				const newPoolImpl = await Pool_implementation_factory.deploy()

				await expect(
					newPoolImpl.connect(deployer).__init_UFarmPool(fakeInitPoolCallStruct, realAddr),
				).to.be.revertedWithCustomError(newPoolImpl, 'NotDelegateCalled')

				await Pool_beacon.connect(deployer).upgradeTo(newPoolImpl.address)

				await expect(
					newPoolImpl.connect(deployer).__init_UFarmPool(fakeInitPoolCallStruct, realAddr),
				).to.be.revertedWithCustomError(newPoolImpl, 'NotDelegateCalled')

				await expect(UFarmFund_instance.createPool(emptyPoolArgs, ethers.utils.randomBytes(32))).to
					.be.not.reverted
			})
			it('PoolAdmin can be updated', async function () {
				const { deployer, bob, PoolAdmin_beacon, initialized_pool_instance } = await loadFixture(
					fundWithPoolFixture,
				)

				expect(await initialized_pool_instance.admin.owner()).to.eq(
					ethers.constants.AddressZero,
					'Beacon should be permissionless',
				)

				expect(await PoolAdmin_beacon.owner()).to.eq(
					deployer.address,
					'Beacon should be owned by deployer',
				)

				const mockPoolAdminFactory = (await ethers.getContractFactory(
					'MockPoolAdmin',
				)) as MockPoolAdmin__factory

				const mockPoolAdminImpl = await mockPoolAdminFactory.deploy()

				const upgradedPoolAdmin = mockPoolAdminFactory.attach(
					initialized_pool_instance.admin.address,
				) as MockPoolAdmin

				await expect(upgradedPoolAdmin.getBlockTimestamp()).to.be.reverted

				await expect(
					initialized_pool_instance.admin.connect(deployer).upgradeTo(mockPoolAdminImpl.address),
				).to.be.revertedWith('Function must be called through active proxy')

				await expect(
					PoolAdmin_beacon.connect(bob).upgradeTo(mockPoolAdminImpl.address),
				).to.be.revertedWith('Ownable: caller is not the owner')

				await expect(PoolAdmin_beacon.connect(deployer).upgradeTo(mockPoolAdminImpl.address)).to.be
					.not.reverted

				await expect(upgradedPoolAdmin.getBlockTimestamp()).to.be.not.reverted
			})
			it('UFarmFund can be updated', async function () {
				const { deployer, bob, Fund_beacon, UFarmFund_instance } = await loadFixture(
					UFarmFundFixture,
				)

				expect(await UFarmFund_instance.owner()).to.eq(
					ethers.constants.AddressZero,
					'Fund should be permissionless',
				)

				expect(await Fund_beacon.owner()).to.eq(
					deployer.address,
					'Beacon should be owned by deployer',
				)

				const mockFundFactory = (await ethers.getContractFactory('Block')) as Block__factory

				const mockFundImpl = await mockFundFactory.deploy()

				const upgradedFund = mockFundFactory.attach(UFarmFund_instance.address)

				await expect(upgradedFund.getBlockTimestamp()).to.be.reverted

				await expect(Fund_beacon.connect(bob).upgradeTo(mockFundImpl.address)).to.be.revertedWith(
					'Ownable: caller is not the owner',
				)

				await expect(Fund_beacon.connect(deployer).upgradeTo(mockFundImpl.address)).to.be.not
					.reverted

				await expect(upgradedFund.getBlockTimestamp()).to.be.not.reverted
			})
		})
		describe('UUPS update tests', function () {
			it('UFarmCore can be updated', async function () {
				const { deployer, bob, UFarmCore_instance, Core_implementation_factory } =
					await loadFixture(UFarmFundFixture)

				expect(await UFarmCore_instance.owner()).to.eq(
					deployer.address,
					'Beacon should be owned by deployer',
				)

				const mockCoreFactory = (await ethers.getContractFactory('UUPSBlock')) as UUPSBlock__factory

				const mockCoreImpl = await mockCoreFactory.deploy()
				const coreImpl = await Core_implementation_factory.deploy()

				const upgradedCore = mockCoreFactory.attach(UFarmCore_instance.address)

				await expect(upgradedCore.getBlockTimestamp()).to.be.reverted

				await expect(
					UFarmCore_instance.connect(bob).upgradeTo(coreImpl.address),
				).to.be.revertedWith('Ownable: caller is not the owner')

				await expect(UFarmCore_instance.connect(deployer).upgradeTo(coreImpl.address)).to.be.not
					.reverted
				await expect(UFarmCore_instance.fundsCount()).to.be.not.reverted

				await expect(UFarmCore_instance.connect(deployer).transferOwnership(bob.address)).to.be.not
					.reverted

				await expect(UFarmCore_instance.connect(bob).upgradeTo(mockCoreImpl.address)).to.be.not
					.reverted
				await expect(upgradedCore.getBlockTimestamp()).to.be.not.reverted
			})
			it('PriceOracle can be updated', async function () {
				const { deployer, bob, PriceOracle_instance, PriceOracle_factory } = await loadFixture(
					UFarmFundFixture,
				)

				expect(await PriceOracle_instance.owner()).to.eq(
					deployer.address,
					'Beacon should be owned by deployer',
				)

				const oracleImpl = await PriceOracle_factory.deploy()
				const anotherOracleImpl = await PriceOracle_factory.deploy()

				await expect(PriceOracle_instance.ufarmCore()).to.be.not.rejected

				await expect(
					PriceOracle_instance.connect(bob).upgradeTo(oracleImpl.address),
				).to.be.revertedWith('Ownable: caller is not the owner')

				await expect(PriceOracle_instance.connect(deployer).upgradeTo(oracleImpl.address)).to.be.not
					.reverted

				await expect(PriceOracle_instance.connect(deployer).transferOwnership(bob.address)).to.be
					.not.reverted
				await expect(PriceOracle_instance.connect(deployer).transferOwnership(bob.address)).to.be
					.reverted
				await expect(PriceOracle_instance.ufarmCore()).to.not.be.rejected

				await expect(PriceOracle_instance.connect(bob).upgradeTo(anotherOracleImpl.address)).to.be
					.not.reverted

				await expect(PriceOracle_instance.ufarmCore()).to.not.be.rejected
			})
		})
		it('Should check oneinch data with univ2 like swap', async function () {
			const { oneInchAggrV5_instance, alice, bob, tokens, UnoswapV2Controller_instance } =
				await loadFixture(fundWithPoolFixture)

			const transferAmount = ethers.utils.parseUnits('300', 6)

			const injectedOneInchResponse = await oneInchCustomUnoswapTo(
				oneInchAggrV5_instance.address,
				transferAmount,
				0,
				bob.address,
				[tokens.USDT.address, tokens.WETH.address],
				UnoswapV2Controller_instance,
			)

			await tokens.USDT.mint(alice.address, transferAmount)
			await tokens.USDT.connect(alice).approve(oneInchAggrV5_instance.address, transferAmount)
			const tx = alice.sendTransaction({
				...injectedOneInchResponse.tx,
			})

			await expect(tx).to.be.not.reverted
		})
		it('Should check oneinch data with univ3 like swap', async function () {
			const {
				oneInchAggrV5_instance,
				alice,
				bob,
				tokens,
				uniswapV3Factory_instance,
				inchConverter_instance,
				quoter_instance,
			} = await loadFixture(fundWithPoolFixture)

			const transferAmount = ethers.utils.parseUnits('200', 6)

			const swapData: OneInchToUfarmTestEnv.UniswapV3CustomDataStruct = {
				customRecipient: bob.address,
				customAmountIn: transferAmount,
				// customRoute: [tokens.USDT.address, tokens.WETH.address],
				customRoute: uniV3_tokensFeesToPath([tokens.USDT.address, 3000, tokens.WETH.address]),
				factory: uniswapV3Factory_instance.address,
				positionManager: inchConverter_instance.address,
				quoter: quoter_instance.address,
				minReturn: 1,
				unwrapWethOut: false,
			}

			const injectedOneInchResponse =
				await inchConverter_instance.callStatic.toOneInchUniswapV3SwapTo(swapData)

			await tokens.USDT.mint(alice.address, transferAmount)
			await tokens.USDT.connect(alice).approve(oneInchAggrV5_instance.address, transferAmount)
			const tx = alice.sendTransaction({
				to: oneInchAggrV5_instance.address,
				data: injectedOneInchResponse.customTxData.data,
			})

			await expect(tx).to.be.not.reverted
		})
		it('Initial values from struct should be correct', async function () {
			const { UFarmPool_instance, tokens, alice, bob, poolArgs } = await loadFixture(
				fundWithPoolFixture,
			)

			const poolConfig = await UFarmPool_instance.admin.getConfig()

			// minInvestment: 1 as BigNumberish,
			expect(poolConfig.minInvestment).to.eq(
				poolArgs.minInvestment,
				'minInvestment should be correct',
			)

			// maxInvestment: ethers.utils.parseUnits('1000000', 6),
			expect(poolConfig.maxInvestment).to.eq(
				poolArgs.maxInvestment,
				'maxInvestment should be correct',
			)

			// managementCommission: 2 as BigNumberish,
			expect(poolConfig.managementCommission).to.eq(
				poolArgs.managementCommission,
				'managementCommission should be correct',
			)

			// performanceCommission: 3 as BigNumberish,
			expect(poolConfig.packedPerformanceFee).to.eq(
				poolArgs.packedPerformanceCommission,
				'performanceCommission should be correct',
			)

			// valueToken: USDT.address,
			expect(await UFarmPool_instance.pool.valueToken()).to.eq(
				poolArgs.valueToken,
				'valueToken should be correct',
			)

			const fullPermissionsMask = bitsToBigNumber(
				Array.from(Object.values(constants.Pool.Permissions)),
			)

			expect(
				await UFarmPool_instance.admin.hasPermissionsMask(alice.address, fullPermissionsMask),
			).to.eq(true, 'owner should be correct')

			// staff: [],

			// name: 'Pool name',
			expect(await UFarmPool_instance.pool.name()).to.eq(
				'UFarm-'.concat(await poolArgs.name),
				'name should be correct',
			)

			// symbol: 'Pool symbol',
			expect(await UFarmPool_instance.pool.symbol()).to.eq(
				'UF-'.concat(await poolArgs.symbol),
				'symbol should be correct',
			)
		})
		it('Initial fund balance == total Asset Cost == 0', async function () {
			const { UFarmPool_instance, tokens, alice, bob } = await loadFixture(fundWithPoolFixture)

			expect(await tokens.USDT.balanceOf(UFarmPool_instance.pool.address)).to.eq(
				0,
				'initial balance of pool should be 0',
			)

			expect(await UFarmPool_instance.pool.getTotalCost()).to.eq(
				0,
				'initial totalAssetCost should be 0',
			)
		})
		it('Shouldn`t call Quex callback if not quex logic', async function () {
			const { UFarmPool_instance, QuexCore_instance } = await loadFixture(fundWithPoolFixture)
	
			await expect(QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, 0)).to.not.be.reverted

			const feedId = ethers.utils.formatBytes32String("feedId")
			const item = {
				timestamp: Math.floor(Date.now() / 1000),
				feedId,
				value: ethers.utils.toUtf8Bytes("someValue"),
			}
			await expect(UFarmPool_instance.pool.quexCallback(feedId, item)).to.be.revertedWithCustomError(UFarmPool_instance.pool, 'InvalidQuexCore')
		})
		it('Should change quexFlowVersion', async function () {
			const { PriceOracle_instance, deployer, QuexPool_instance, blankPool_instance, bob, tokens } = await loadFixture(fundWithPoolFixture)

			const HTTPStruct: HTTPRequestStruct = { 
				method: 0,
				path: '',
				host: '',
				headers: [],
				parameters: [],
				body: ethers.utils.toUtf8Bytes(''),
			}

			const patchId = ethers.constants.HashZero
			const schemaId = ethers.constants.HashZero
			const filterId = ethers.constants.HashZero

			const coreInitVersion = await PriceOracle_instance.connect(deployer).quexFlowVersion()
			await PriceOracle_instance.connect(deployer).setQuexFlow(QuexPool_instance.address, HTTPStruct, patchId, schemaId, filterId)
			expect(await PriceOracle_instance.connect(deployer).quexFlowVersion()).to.be.eq(coreInitVersion.add(1))

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)
			await tokens.USDT.mint(bob.address, constants.ONE_HUNDRED_BUCKS)
			await tokens.USDT.connect(bob).approve(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)


			let poolInitVersion = await blankPool_instance.pool.quexFlowVersion()
			await blankPool_instance.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())
			expect(await blankPool_instance.pool.quexFlowVersion()).to.be.eq(poolInitVersion.add(1))

			poolInitVersion = await blankPool_instance.pool.quexFlowVersion()
			await blankPool_instance.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())
			expect(await blankPool_instance.pool.quexFlowVersion()).to.be.eq(poolInitVersion)
		}),
		it(`Alice's $20, Bob's $10 `, async function () {
			// TODO: TEST FAILS IF POOL HAS LARGE BALANCE
			const { UFarmPool_instance, tokens, alice, bob, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const TEN_BUCKS = ethers.utils.parseUnits('10', 6)
			const TWENTY_BUCKS = ethers.utils.parseUnits('20', 6)
			const THIRTY_BUCKS = ethers.utils.parseUnits('30', 6)

			await Promise.all([
				tokens.USDT.connect(alice).mint(alice.address, TWENTY_BUCKS),
				tokens.USDT.connect(alice).mint(bob.address, TEN_BUCKS),
			])

			await tokens.USDT.connect(alice).approve(UFarmPool_instance.pool.address, TWENTY_BUCKS)
			await UFarmPool_instance.pool.connect(alice).deposit(TWENTY_BUCKS, nullClientVerification())

			await tokens.USDT.connect(bob).approve(UFarmPool_instance.pool.address, TEN_BUCKS)
			await UFarmPool_instance.pool.connect(bob).deposit(TEN_BUCKS, nullClientVerification())

			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, 0)

			expect(await UFarmPool_instance.pool.balanceOf(alice.address)).to.eq(
				TWENTY_BUCKS,
				'initial share balance of alice should be 20',
			)

			expect(await UFarmPool_instance.pool.balanceOf(bob.address)).to.eq(
				TEN_BUCKS,
				'initial share balance of bob should be 10',
			)

			const alice_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: TWENTY_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('alice'),
				poolAddr: UFarmPool_instance.pool.address,
			}
			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: TEN_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: UFarmPool_instance.pool.address,
			}

			const alice_signedWithdrawalRequest = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				alice,
				alice_withdrawalRequest,
			)

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)

			await UFarmPool_instance.pool.connect(alice).withdraw({
				body: alice_signedWithdrawalRequest.msg,
				signature: alice_signedWithdrawalRequest.sig,
			})
			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, THIRTY_BUCKS)

			await UFarmPool_instance.pool.connect(bob).withdraw({
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			})

			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, TEN_BUCKS)

			expect(await tokens.USDT.balanceOf(alice.address)).to.eq(
				TWENTY_BUCKS,
				'alice should have 20 USDT',
			)

			expect(await tokens.USDT.balanceOf(bob.address)).to.eq(TEN_BUCKS, 'bob should have 10 USDT')
		})
		it(`Alice deposit and request withdraw with slippage protection`, async function () {
			// TODO: TEST FAILS IF POOL HAS LARGE BALANCE
			const { UFarmPool_instance, tokens, alice, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const ZERO_BUCKS = ethers.utils.parseUnits('0', 6)
			const TEN_BUCKS = ethers.utils.parseUnits('10', 6)
			const TWENTY_BUCKS = ethers.utils.parseUnits('20', 6)
			const TWENTY_FIVE_BUCKS = ethers.utils.parseUnits('25', 6)
			const THIRTY_BUCKS = ethers.utils.parseUnits('30', 6)

			await tokens.USDT.connect(alice).mint(alice.address, TWENTY_BUCKS)
			await tokens.USDT.connect(alice).approve(UFarmPool_instance.pool.address, TWENTY_BUCKS)
			await UFarmPool_instance.pool.connect(alice).deposit(TWENTY_BUCKS, nullClientVerification())

			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, 0)

			expect(await UFarmPool_instance.pool.balanceOf(alice.address)).to.eq(
				TWENTY_BUCKS,
				'initial share balance of alice should be 20',
			)

			const alice_withdrawalRequest1: WithdrawRequestStruct = {
				sharesToBurn: TWENTY_BUCKS,
				minOutputAmount: TWENTY_FIVE_BUCKS,
				salt: protocolToBytes32('alice1'),
				poolAddr: UFarmPool_instance.pool.address,
			}
			const alice_signedWithdrawalRequest1 = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				alice,
				alice_withdrawalRequest1,
			)

			await UFarmPool_instance.pool.connect(alice).withdraw({
				body: alice_signedWithdrawalRequest1.msg,
				signature: alice_signedWithdrawalRequest1.sig,
			})
			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, TWENTY_BUCKS)

			expect(await tokens.USDT.balanceOf(alice.address)).to.eq(
				ZERO_BUCKS,
				'The withdraw should not happen',
			)

			const alice_withdrawalRequest2: WithdrawRequestStruct = {
				sharesToBurn: TWENTY_BUCKS,
				minOutputAmount: TWENTY_FIVE_BUCKS,
				salt: protocolToBytes32('alice2'),
				poolAddr: UFarmPool_instance.pool.address,
			}
			const alice_signedWithdrawalRequest2 = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				alice,
				alice_withdrawalRequest2,
			)

			await UFarmPool_instance.pool.connect(alice).withdraw({
				body: alice_signedWithdrawalRequest2.msg,
				signature: alice_signedWithdrawalRequest2.sig,
			})
			await tokens.USDT.connect(alice).mint(UFarmPool_instance.pool.address, TEN_BUCKS)
			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, THIRTY_BUCKS)

			expect(await tokens.USDT.balanceOf(alice.address)).to.gte(
				TWENTY_FIVE_BUCKS,
				'alice should have > 25 USDT',
			)
		})
		it('Should process valid deposit request with slippage protection', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const amountToInvest = constants.ONE_HUNDRED_BUCKS

			await tokens.USDT.mint(bob.address, amountToInvest)
			await tokens.USDT.connect(bob).approve(initialized_pool_instance.pool.address, amountToInvest)

			const depositRequest_body1 = {
				amountToInvest: amountToInvest,
				minOutputAmount: constants.ONE_HUNDRED_BUCKS.add(constants.ONE_BUCKS),
				salt: protocolToBytes32('request1'),
				poolAddr: initialized_pool_instance.pool.address,
				deadline: (await time.latest()) + constants.Date.DAY,
				bearerToken: tokens.USDT.address,
			} as DepositRequestStruct

			const request1 = await _signDepositRequest(
				initialized_pool_instance.pool,
				bob,
				depositRequest_body1,
			)

			const requestStruct1 = {
				body: request1.msg,
				signature: request1.sig,
			}

			await initialized_pool_instance.pool.approveDeposits([requestStruct1])
			const tx1 = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			const depositRequest_body2 = {
				amountToInvest: amountToInvest,
				minOutputAmount: constants.ONE_HUNDRED_BUCKS,
				salt: protocolToBytes32('request2'),
				poolAddr: initialized_pool_instance.pool.address,
				deadline: (await time.latest()) + constants.Date.DAY,
				bearerToken: tokens.USDT.address,
			} as DepositRequestStruct

			const request2 = await _signDepositRequest(
				initialized_pool_instance.pool,
				bob,
				depositRequest_body2,
			)

			const requestStruct2 = {
				body: request2.msg,
				signature: request2.sig,
			}

			await initialized_pool_instance.pool.approveDeposits([requestStruct2])
			const tx2 = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			await expect(tx2)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, request2.hash)
				.to.changeTokenBalances(
					tokens.USDT,
					[bob, initialized_pool_instance.pool],
					[amountToInvest.mul(-1), amountToInvest],
				)
		})
		it('Should mint and burn tokens in exchange for base token', async function () {
			const { UFarmPool_instance, tokens, alice, bob, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const FIFTY_BUCKS = ethers.utils.parseUnits('50', 6)
			const ONE_HUNDRED_BUCKS = ethers.utils.parseUnits('100', 6)
			const TWO_HUNDRED_BUCKS = ethers.utils.parseUnits('200', 6)
			let TOTAL_COST = ethers.utils.parseUnits('0', 6)

			// Mint some USDT for alice and bob
			await Promise.all([
				tokens.USDT.connect(alice).mint(alice.address, ONE_HUNDRED_BUCKS),
				tokens.USDT.connect(alice).mint(bob.address, TWO_HUNDRED_BUCKS),
			])

			// Alice invests 100 USDT
			await tokens.USDT.connect(alice).approve(UFarmPool_instance.pool.address, ONE_HUNDRED_BUCKS)

			await UFarmPool_instance.pool.connect(alice).deposit(ONE_HUNDRED_BUCKS, nullClientVerification())
			TOTAL_COST = TOTAL_COST.add(ONE_HUNDRED_BUCKS)

			// Bob invests 200 USDT
			await tokens.USDT.connect(bob).approve(UFarmPool_instance.pool.address, TWO_HUNDRED_BUCKS)
			await UFarmPool_instance.pool.connect(bob).deposit(TWO_HUNDRED_BUCKS, nullClientVerification())
			TOTAL_COST = TOTAL_COST.add(TWO_HUNDRED_BUCKS)
			
			await expect(QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, 0))
				.to.emit(UFarmPool_instance.pool, 'Transfer')
				.withArgs(ethers.constants.AddressZero, alice.address, ONE_HUNDRED_BUCKS)
				.to.emit(UFarmPool_instance.pool, 'Deposit')
				.withArgs(alice.address, tokens.USDT.address, ONE_HUNDRED_BUCKS, ONE_HUNDRED_BUCKS)
			
			expect(await UFarmPool_instance.pool.balanceOf(bob.address)).to.equal(
				TWO_HUNDRED_BUCKS,
				'initial balance of bob should be 200',
			)

			expect(await UFarmPool_instance.pool.totalSupply()).to.equal(
				ONE_HUNDRED_BUCKS.add(TWO_HUNDRED_BUCKS),
				'total supply should be 300: 100 from alice, 200 from bob',
			)

			// Alice withdraws 50 USDT
			expect(await tokens.USDT.balanceOf(alice.address)).to.equal(0)

			const alice_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: FIFTY_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('alice'),
				poolAddr: UFarmPool_instance.pool.address,
			}

			const alice_signedWithdrawalRequest = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				alice,
				alice_withdrawalRequest,
			)

			await UFarmPool_instance.pool
				.connect(alice)
				.approve(UFarmPool_instance.pool.address, FIFTY_BUCKS)
			await UFarmPool_instance.pool.connect(alice).withdraw({
				body: alice_signedWithdrawalRequest.msg,
				signature: alice_signedWithdrawalRequest.sig,
			}),
			await expect(
				QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, TOTAL_COST)
			)
				.to.emit(tokens.USDT, `Transfer`)
				.withArgs(UFarmPool_instance.pool.address, alice.address, FIFTY_BUCKS)
				.to.emit(UFarmPool_instance.pool, `Transfer`)
				.withArgs(alice.address, ethers.constants.AddressZero, FIFTY_BUCKS)

			TOTAL_COST = TOTAL_COST.sub(FIFTY_BUCKS)
			
			const alice_withdrawalRequest2: WithdrawRequestStruct = {
				sharesToBurn: FIFTY_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('alice2'),
				poolAddr: UFarmPool_instance.pool.address,
			}

			const alice_signedWithdrawalRequest2 = await _signWithdrawRequest(
				UFarmPool_instance.pool,
				alice,
				alice_withdrawalRequest2,
			)

			// Alice withdraws 50 USDT
			await UFarmPool_instance.pool
				.connect(alice)
				.approve(UFarmPool_instance.pool.address, FIFTY_BUCKS)
			await UFarmPool_instance.pool.connect(alice).withdraw({
				body: alice_signedWithdrawalRequest2.msg,
				signature: alice_signedWithdrawalRequest2.sig,
			})
			await QuexCore_instance.sendResponse(UFarmPool_instance.pool.address, TOTAL_COST)
			TOTAL_COST = TOTAL_COST.sub(FIFTY_BUCKS)

			expect(await tokens.USDT.balanceOf(alice.address)).to.eq(ONE_HUNDRED_BUCKS)
		})
		it('Addresses test', async function () {
			const {
				ethPool_instance,
				alice,
				bob,
				UFarmCore_instance,
				PriceOracle_instance,
				UniswapV2Router02_instance,
			} = await loadFixture(ETHPoolFixture)

			expect(await ethPool_instance.pool.ufarmCore()).to.eq(
				UFarmCore_instance.address,
				'ufarmCore should be UFarmCore_instance.address',
			)

			expect(await UFarmCore_instance.priceOracle()).to.eq(
				PriceOracle_instance.address,
				'priceOracle should be PriceOracle_instance.address',
			)
		})
		it('Initial cost of assets should be correct', async function () {
			const { ethPool_instance, tokens, MANAGERS_INVESTMENT } = await loadFixture(ETHPoolFixture)

			const cost = await ethPool_instance.pool.getTotalCost()
			const tolerance = MANAGERS_INVESTMENT.div(100) // 1%
			expect(cost).to.approximately(
				MANAGERS_INVESTMENT,
				tolerance,
				'initial asset cost should be correct',
			)
		})
		it.skip('Manager should exchange ETH with profit, users should gain USDT', async function () {
			const {
				ethPool_instance,
				bob,
				carol,
				wallet,
				tokens,
				UnoswapV2Controller_instance,
				UniswapV2Factory_instance,
				UniswapV2Router02_instance,
				QuexCore_instance,
				MANAGERS_INVESTMENT
			} = await loadFixture(ETHPoolFixture)

			const BOB_INVESTMENT = ethers.utils.parseUnits('900', 6)
			const CAROL_INVESTMENT = ethers.utils.parseUnits('1800', 6)
			let TOTAL_COST = ethers.utils.parseUnits('0', 6)

			let [usdtAssetsBalance, wethAssetsBalance] = await Promise.all([
				tokens.USDT.balanceOf(ethPool_instance.pool.address),
				tokens.WETH.balanceOf(ethPool_instance.pool.address),
			])

			await mintAndDeposit(ethPool_instance.pool, tokens.USDT, bob, BOB_INVESTMENT)
			await QuexCore_instance.sendResponse(ethPool_instance.pool.address, TOTAL_COST)

			usdtAssetsBalance = usdtAssetsBalance.add(BOB_INVESTMENT)
			TOTAL_COST = TOTAL_COST.add(BOB_INVESTMENT)

			expect(await tokens.USDT.balanceOf(ethPool_instance.pool.address)).to.eq(
				usdtAssetsBalance,
				'usdtAssetsBalance check 2',
			)

			await mintAndDeposit(ethPool_instance.pool, tokens.USDT, carol, CAROL_INVESTMENT)
			await QuexCore_instance.sendResponse(ethPool_instance.pool.address, TOTAL_COST)
			usdtAssetsBalance = usdtAssetsBalance.add(CAROL_INVESTMENT)
			TOTAL_COST = TOTAL_COST.add(CAROL_INVESTMENT)

			expect(await tokens.USDT.balanceOf(ethPool_instance.pool.address)).to.eq(
				usdtAssetsBalance,
				'usdtAssetsBalance check 3',
			)

			// Show USDT balance of the pool:
			const usdtBalance = await tokens.USDT.balanceOf(ethPool_instance.pool.address)

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				ethers.utils.parseUnits('1000', 6),
				wallet,
				UniswapV2Factory_instance,
			)
			
			// Exchange USDT to ETH in the pool:
			const gettingWeth = (
				await _poolSwapUniV2(ethPool_instance.pool, UnoswapV2Controller_instance, usdtBalance, [
					tokens.USDT.address,
					tokens.WETH.address,
				])
			).amountOut

			usdtAssetsBalance = usdtAssetsBalance.sub(usdtBalance)
			wethAssetsBalance = wethAssetsBalance.add(gettingWeth)

			expect(await tokens.USDT.balanceOf(ethPool_instance.pool.address)).to.eq(
				usdtAssetsBalance,
				'USDT fetched balance should be correct after the first swap',
			)

			expect(await tokens.WETH.balanceOf(ethPool_instance.pool.address)).to.eq(
				wethAssetsBalance,
				'WETH fetched balance should be correct after the first swap',
			)

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				ethers.utils.parseUnits('10000', 6),
				wallet,
				UniswapV2Factory_instance,
			)

			const newPriceRate = await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)

			expect(newPriceRate).to.be.greaterThanOrEqual(
				ethers.utils.parseUnits('2000', 6),
				'price is not greater than 2000',
			)

			// Exchange ETH to USDT in the pool:
			const wethBalance2 = await tokens.WETH.balanceOf(ethPool_instance.pool.address)

			const gettingUSDT = (
				await _poolSwapUniV2(ethPool_instance.pool, UnoswapV2Controller_instance, wethBalance2, [
					tokens.WETH.address,
					tokens.USDT.address,
				])
			).amountOut

			usdtAssetsBalance = usdtAssetsBalance.add(gettingUSDT)
			wethAssetsBalance = wethAssetsBalance.sub(wethBalance2)

			expect(await tokens.USDT.balanceOf(ethPool_instance.pool.address)).to.eq(
				usdtAssetsBalance,
				'USDT fetched balance should be correct after the second swap',
			)

			expect(await tokens.WETH.balanceOf(ethPool_instance.pool.address)).to.eq(
				wethAssetsBalance,
				'WETH fetched balance should be correct after the second swap',
			)

			// Withdraw all pool shares:
			const bobShares = await ethPool_instance.pool.balanceOf(bob.address)
			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: bobShares,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: ethPool_instance.pool.address,
			}

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				ethPool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)
			await ethPool_instance.pool.connect(bob).withdraw({
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			})

			const carolShares = await ethPool_instance.pool.balanceOf(carol.address)

			const carol_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: carolShares,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('carol'),
				poolAddr: ethPool_instance.pool.address,
			}

			const carol_signedWithdrawalRequest = await _signWithdrawRequest(
				ethPool_instance.pool,
				carol,
				carol_withdrawalRequest,
			)

			await ethPool_instance.pool.connect(carol).withdraw({
				body: carol_signedWithdrawalRequest.msg,
				signature: carol_signedWithdrawalRequest.sig,
			})

			await QuexCore_instance.sendResponse(ethPool_instance.pool.address, usdtAssetsBalance)

			// Bob and Carol should get more USDT than they invested:
			const bobUsdtBalance = await tokens.USDT.balanceOf(bob.address)
			const carolUsdtBalance = await tokens.USDT.balanceOf(carol.address)

			expect(bobUsdtBalance).to.be.greaterThanOrEqual(
				BOB_INVESTMENT,
				"Bob's USDT balance should be greater than his investment",
			)

			expect(carolUsdtBalance).to.be.greaterThanOrEqual(
				CAROL_INVESTMENT,
				"Carol's USDT balance should be greater than her investment",
			)
		})
		it('Fund can withdraw own assets', async () => {
			const { UFarmFund_instance, ethPool_instance, UnoswapV2Controller_instance, tokens, bob, QuexCore_instance, MANAGERS_INVESTMENT } =
				await loadFixture(ETHPoolFixture)

			const sharesBalance = await ethPool_instance.pool.balanceOf(UFarmFund_instance.address)

			await _poolSwapUniV2(
				ethPool_instance.pool,
				UnoswapV2Controller_instance,
				await tokens.WETH.balanceOf(ethPool_instance.pool.address),
				[tokens.WETH.address, tokens.USDT.address],
			)

			// Fund withdraws all assets from the pool:
			const fund_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: sharesBalance,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('fund'),
				poolAddr: ethPool_instance.pool.address,
			}

			const fund_signedWithdrawalRequest = await _signWithdrawRequest(
				ethPool_instance.pool,
				bob,
				fund_withdrawalRequest,
			)

			await UFarmFund_instance.withdrawFromPool({
				body: fund_signedWithdrawalRequest.msg,
				signature: fund_signedWithdrawalRequest.sig,
			}, tokens.USDT.address)

			let cost = await tokens.USDT.balanceOf(ethPool_instance.pool.address)
			await QuexCore_instance.sendResponse(ethPool_instance.pool.address, cost)

			expect(await ethPool_instance.pool.totalSupply()).to.eq(0, 'Pool shares should be burned')

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				ethPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await UFarmFund_instance.depositToPool(
				ethPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await expect(() =>
				QuexCore_instance.sendResponse(ethPool_instance.pool.address, 0),
			).to.changeTokenBalance(
				ethPool_instance.pool,
				UFarmFund_instance.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			const fund_withdrawalRequest2: WithdrawRequestStruct = {
				sharesToBurn: constants.ONE_HUNDRED_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('fund'),
				poolAddr: ethPool_instance.pool.address,
			}

			const fund_signedWithdrawalRequest2 = await _signWithdrawRequest(
				ethPool_instance.pool,
				bob,
				fund_withdrawalRequest2,
			)

			await UFarmFund_instance.withdrawFromPool({
				body: fund_signedWithdrawalRequest2.msg,
				signature: fund_signedWithdrawalRequest2.sig,
			}, tokens.USDT.address)
			cost = await tokens.USDT.balanceOf(ethPool_instance.pool.address)
			await expect(() =>
				QuexCore_instance.sendResponse(ethPool_instance.pool.address, cost),
			).to.changeTokenBalance(tokens.USDT, UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS)
		})
	})
	describe('State tests', () => {
		it("Investors shouldn't be able to deposit if fund is approved", async () => {
			const { UFarmFund_instance, poolArgs, tokens, alice, bob } = await loadFixture(
				UFarmFundFixture,
			)

			expect(await UFarmFund_instance.status()).to.eq(
				constants.Fund.State.Approved,
				'Fund should be in Approved state',
			)

			const newPool = await deployPool(poolArgs, UFarmFund_instance)

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))
			await tokens.USDT.mint(bob.address, constants.ONE_HUNDRED_BUCKS)
			await tokens.USDT.connect(bob).approve(newPool.pool.address, constants.ONE_HUNDRED_BUCKS)

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				newPool.pool.address,
				constants.ONE_HUNDRED_BUCKS.mul(2),
			)

			await expect(newPool.admin.changePoolStatus(constants.Pool.State.Active))
				.to.be.revertedWithCustomError(newPool.pool, 'WrongFundStatus')
				.withArgs(constants.Fund.State.Active, constants.Fund.State.Approved)

			await expect(newPool.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification()))
				.to.be.revertedWithCustomError(newPool.pool, 'WrongFundStatus')
				.withArgs(constants.Fund.State.Active, constants.Fund.State.Approved)

			await UFarmFund_instance.changeStatus(constants.Fund.State.Active)

			await expect(newPool.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification()))
				.to.be.revertedWithCustomError(newPool.pool, 'InvalidPoolStatus')
				.withArgs(constants.Pool.State.Active, constants.Pool.State.Created)

			await expect(newPool.admin.changePoolStatus(constants.Pool.State.Active)).to.be.not.reverted

			await expect(newPool.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())).to.be.not
				.reverted
		})
	})
	describe('HighWaterMark tests', () => {
		it('Should increase HWM after pool deposit', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const initialHWM = await initialized_pool_instance.pool.highWaterMark()

			await tokens.USDT.mint(bob.address, constants.ONE_HUNDRED_BUCKS)
			await tokens.USDT.connect(bob).approve(
				initialized_pool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await initialized_pool_instance.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			expect(await initialized_pool_instance.pool.highWaterMark()).to.eq(
				initialHWM.add(constants.ONE_HUNDRED_BUCKS),
			)
		})

		it('Should decrease HWM after pool withdraw', async () => {
			const { initialized_pool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			const initialHWM = await initialized_pool_instance.pool.highWaterMark()

			await tokens.USDT.mint(bob.address, constants.ONE_HUNDRED_BUCKS)
			await tokens.USDT.connect(bob).approve(
				initialized_pool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await initialized_pool_instance.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)
			expect(await initialized_pool_instance.pool.highWaterMark()).to.eq(
				initialHWM.add(constants.ONE_HUNDRED_BUCKS),
			)

			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: constants.ONE_HUNDRED_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: initialized_pool_instance.pool.address,
			}

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				initialized_pool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)

			await initialized_pool_instance.pool.connect(bob).withdraw({
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			})
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)

			expect(await initialized_pool_instance.pool.highWaterMark()).to.eq(initialHWM)
		})
	})
	describe('Performance fee tests', () => {
		it('Performance commission should be in range while pool creation', async () => {
			// can't handle error from constructor =(
			const { UFarmFund_instance, poolArgs, tokens, alice } = await loadFixture(UFarmFundFixture)

			const encodeCommission = (commission: BigNumberish) =>
				packPerformanceCommission([{ step: 0, commission: toBigInt(commission) }])

			const maxPerformanceCommission = constants.Pool.Commission.ONE_HUNDRED_PERCENT / 2

			// more than max
			await expect(
				deployPool(
					{
						...poolArgs,
						name: 'More than max 1',
						packedPerformanceCommission: encodeCommission(maxPerformanceCommission + 1),
					} as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.reverted

			// more than max
			await expect(
				deployPool(
					{
						...poolArgs,
						name: `More than max 2`,
						packedPerformanceCommission: ethers.constants.MaxUint256,
					} as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.reverted

			// max
			await expect(
				deployPool(
					{
						...poolArgs,
						name: 'Max 1',
						packedPerformanceCommission: encodeCommission(maxPerformanceCommission),
					} as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.not.reverted

			// min
			await expect(
				deployPool(
					{ ...poolArgs, name: 'Min 1', packedPerformanceCommission: 0 } as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.not.reverted

			// min
			await expect(
				deployPool(
					{
						...poolArgs,
						name: 'Min 2',
						packedPerformanceCommission: encodeCommission(0),
					} as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.not.reverted
		})
		it('Performance and Management commissions should be in range while changing', async () => {
			const { UFarmFund_instance, tokens, poolArgs, alice, bob } = await loadFixture(
				fundWithPoolFixture,
			)
			const maxManagementCommission = constants.ONE.div(10)
			const maxPerformanceCommission = constants.Pool.Commission.ONE_HUNDRED_PERCENT / 2

			const outOfRangeManagementCommission = maxManagementCommission.add(1)
			const outOfRangePerformanceCommission = maxPerformanceCommission + 1

			const newPool = await deployPool(
				{
					...poolArgs,
					performanceCommission: constants.ZERO,
					managementCommission: constants.ZERO,
				} as PoolCreationStruct,
				UFarmFund_instance,
			)

			// more than max management commission
			await expect(
				newPool.admin.setCommissions(outOfRangeManagementCommission, constants.ZERO),
			).to.be.revertedWithCustomError(newPool.admin, `ValueNotInRange`)

			// more than max performance commission
			await expect(
				newPool.admin.setCommissions(
					constants.ZERO,
					packPerformanceCommission([{ step: 0, commission: outOfRangePerformanceCommission }]),
				),
			).to.be.revertedWithCustomError(newPool.admin, 'ValueNotInRange')

			// max commissions
			await expect(
				newPool.admin.setCommissions(
					maxManagementCommission,
					packPerformanceCommission([{ step: 0, commission: maxPerformanceCommission }]),
				),
			).to.be.not.reverted

			// min commissions
			await expect(newPool.admin.setCommissions(constants.ZERO, constants.ZERO)).to.be.not.reverted
		})
		it('Should have many performance fee steps', async () => {
			const { UFarmFund_instance, poolArgs, alice } = await loadFixture(UFarmFundFixture)

			await UFarmFund_instance.changeStatus(constants.Fund.State.Active)

			const maxPerformanceCommission = constants.Pool.Commission.ONE_HUNDRED_PERCENT / 2

			const manyCommossionSteps = [
				{ step: 0, commission: maxPerformanceCommission },
				{ step: 10, commission: 0 },
				{ step: 20, commission: maxPerformanceCommission },
				{ step: 37, commission: maxPerformanceCommission / 4 },
				{ step: 255, commission: 2 },
				{ step: 500, commission: 3 },
				{ step: 600, commission: 4 },
				{
					step: constants.Pool.Commission.MAX_COMMISSION_STEP,
					commission: maxPerformanceCommission,
				},
			]

			const manyStepsCommission = packPerformanceCommission(manyCommossionSteps)

			const newPool = await deployPool(
				{
					...poolArgs,
					performanceCommission: constants.ZERO,
					managementCommission: constants.ZERO,
					packedPerformanceCommission: manyStepsCommission,
				} as PoolCreationStruct,
				UFarmFund_instance,
			)

			const poolPerformanceCommission = (await newPool.admin.getConfig()).packedPerformanceFee
			const poolStepsCommission = unpackPerformanceCommission(poolPerformanceCommission)

			expect(poolStepsCommission).to.deep.eq(
				manyCommossionSteps,
				'Performance commission steps should be applied during deploy',
			)

			const newCommissionSteps = manyCommossionSteps.map((step) => ({
				step: step.step,
				commission: Math.floor((step.commission + 2) / 2),
			}))

			await newPool.admin.setCommissions(
				constants.ZERO,
				packPerformanceCommission(newCommissionSteps),
			)

			const newPoolPerformanceCommission = (await newPool.admin.getConfig()).packedPerformanceFee
			const newPoolStepsCommission = unpackPerformanceCommission(newPoolPerformanceCommission)

			expect(newPoolStepsCommission).to.deep.eq(
				newCommissionSteps,
				'Performance commission steps should be applied after deploy',
			)

			// expect(await newPool.pool.performanceCommissionStepsCount()).to.eq(11)
		})
		it('Performance fee should be charged after pool deposit', async () => {
			const {
				blankPool_instance,
				UFarmFund_instance,
				bob,
				tokens,
				UnoswapV2Controller_instance,
				UniswapV2Factory_instance,
				wallet,
				UniswapV2Router02_instance,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)

			const maxPerformanceCommission = constants.Pool.Commission.ONE_HUNDRED_PERCENT / 2

			const maxPerformanceCommissionPacked = packPerformanceCommission([
				{ step: 0, commission: maxPerformanceCommission },
			])

			await blankPool_instance.admin.setCommissions(constants.ZERO, maxPerformanceCommissionPacked) // 50% of profit goes to fund + ufarm

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS)

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			await _poolSwapUniV2(
				blankPool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS,
				[tokens.USDT.address, tokens.WETH.address],
			)

			const initialTotalCost = await blankPool_instance.pool.getTotalCost()

			const totalCostAfterExchange = await blankPool_instance.pool.getTotalCost()

			await tokens.USDT.mint(bob.address, constants.ONE_HUNDRED_BUCKS)
			await tokens.USDT.connect(bob).approve(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)
			await blankPool_instance.pool.connect(bob).deposit(constants.ONE_HUNDRED_BUCKS, nullClientVerification())
			const tx = await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)

			const receipt = await tx.wait()

			const event = getEventFromReceipt(blankPool_instance.pool, receipt, 'FeeAccrued')

			expect(event).to.not.eq(null, 'FeeAccrued event should be emitted')
			if (event === null) return

			const expectedValueChange = totalCostAfterExchange.sub(initialTotalCost)

			const expectedPerformanceFee = expectedValueChange
				.mul(maxPerformanceCommission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			// Should be almost equal with precision of ..
			expect(event.args?.performanceFee).to.approximately(
				expectedPerformanceFee,
				ethers.utils.parseUnits('1', 6),
			) // .. 1 USDT that includes swap fees
		})
		it.skip('Next step fee should be charged after pool deposit', async () => {
			const {
				blankPool_instance,
				UFarmFund_instance,
				bob,
				tokens,
				UnoswapV2Controller_instance,
				UniswapV2Factory_instance,
				wallet,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)
			const manyCommissionSteps = [
				{
					step: 0,
					commission: Math.floor(constants.Pool.Commission.MAX_PERFORMANCE_COMMISION / 100),
				},
				{
					step: Math.floor(constants.Pool.Commission.ONE_HUNDRED_PERCENT),
					commission: Math.floor(constants.Pool.Commission.MAX_PERFORMANCE_COMMISION),
				},
			]
			const manyStepsCommission = packPerformanceCommission(manyCommissionSteps)
			await blankPool_instance.admin.setCommissions(constants.ZERO, manyStepsCommission)

			const depositAmount = constants.ONE_HUNDRED_BUCKS.mul(100)
			let totalCost = ethers.utils.parseUnits('0', 6)

			await tokens.USDT.mint(UFarmFund_instance.address, depositAmount.mul(2))

			await UFarmFund_instance.depositToPool(blankPool_instance.pool.address, depositAmount)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)
			totalCost = totalCost.add(depositAmount)

			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, depositAmount, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			const initialExchangeRate = await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)

			const HWMafterDeposit = await blankPool_instance.pool.highWaterMark()

			const snapshotAfterDeposit = await takeSnapshot()
			const snapshotTotalCost = totalCost

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				initialExchangeRate.mul(2),
				wallet,
				UniswapV2Factory_instance,
			)

			totalCost.mul(2)

			const newRate = await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)

			const totalCostBelow100APY = totalCost
			const profit = totalCostBelow100APY.sub(HWMafterDeposit)
			const apyBelow100 = profit
				.mul(constants.Pool.Commission.ONE_HUNDRED_PERCENT)
				.div(HWMafterDeposit)

			expect(apyBelow100).to.be.lt(
				constants.Pool.Commission.ONE_HUNDRED_PERCENT,
				'APY should be below 100%',
			)

			const expectedPerformanceFeeBelow100 = profit
				.mul(manyCommissionSteps[0].commission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			await UFarmFund_instance.depositToPool(blankPool_instance.pool.address, depositAmount)
			const feeAccruedEvent = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.add(depositAmount)

			expect(feeAccruedEvent.args?.performanceFee).to.approximately(
				expectedPerformanceFeeBelow100,
				100,
				'Performance fee from 1st step should be correct',
			)

			await snapshotAfterDeposit.restore()
			totalCost = snapshotTotalCost

			// 100% <= APY

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				initialExchangeRate.mul(21).div(2),
				wallet,
				UniswapV2Factory_instance,
			)

			totalCost = totalCost.mul(21).div(2)

			const totalCostAbove100APY = totalCost

			const profitAbove100 = totalCostAbove100APY.sub(HWMafterDeposit)

			const apyAbove100 = profitAbove100
				.mul(constants.Pool.Commission.ONE_HUNDRED_PERCENT)
				.div(HWMafterDeposit)

			expect(apyAbove100).to.be.gte(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			const expectedPerformanceFeeAbove100 = profitAbove100
				.mul(manyCommissionSteps[1].commission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			await UFarmFund_instance.depositToPool(blankPool_instance.pool.address, depositAmount)
			const feeAccruedEventAbove100 = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.add(depositAmount)

			expect(feeAccruedEventAbove100.args?.performanceFee).to.approximately(
				expectedPerformanceFeeAbove100,
				100,
				'Performance fee from 2nd step should be correct',
			)
		})

		it.skip('Performance fee should charge to Fund and UFarm after next pool deposit', async () => {
			const {
				blankPool_instance,
				UFarmFund_instance,
				UFarmCore_instance,
				UnoswapV2Controller_instance,
				bob,
				tokens,
				performanceCommission,
				wallet,
				UniswapV2Factory_instance,
				UniswapV2Router02_instance,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)

			const getPoolShares = async (pool: UFarmPool, address: string) => {
				return await pool.balanceOf(address)
			}

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, constants.ONE_HUNDRED_BUCKS)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			await _poolSwapUniV2(
				blankPool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS,
				[tokens.USDT.address, tokens.WETH.address],
			)

			const HWMafterDeposit = await blankPool_instance.pool.highWaterMark()

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				ethers.utils.parseUnits('3600', 6),
				wallet,
				UniswapV2Factory_instance,
			)

			const totalCostAfterRateChange = await blankPool_instance.pool.getTotalCost()
			const totalSupplyBeforeDeposit = await blankPool_instance.pool.totalSupply()
			const fundsPoolSharesBeforeDeposit = await getPoolShares(
				blankPool_instance.pool,
				UFarmFund_instance.address,
			)
			const ufarmPoolSharesBeforeDeposit = await getPoolShares(
				blankPool_instance.pool,
				UFarmCore_instance.address,
			)

			await mintAndDeposit(
				blankPool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS,
			)

			const depositTx = QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)
			const event = await getEventFromTx(depositTx, blankPool_instance.pool, 'FeeAccrued')
			const fundsPoolSharesAfterDeposit = await getPoolShares(
				blankPool_instance.pool,
				UFarmFund_instance.address,
			)
			const ufarmCoreSharesAfterDeposit = await getPoolShares(
				blankPool_instance.pool,
				UFarmCore_instance.address,
			)

			const expectedPerformanceFee = totalCostAfterRateChange
				.sub(HWMafterDeposit)
				.mul(performanceCommission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)
			const feeInShares = expectedPerformanceFee
				.mul(totalSupplyBeforeDeposit)
				.div(totalCostAfterRateChange)

			if (event.args.performanceFee === undefined) throw new Error('Performance fee is undefined')
			const actualPerformanceFeeInValue = event.args.performanceFee as BigNumber

			expect(actualPerformanceFeeInValue).to.eq(
				expectedPerformanceFee,
				'Performance fee in value should be correct',
			)

			const perfFeeToUfarmInValue = actualPerformanceFeeInValue.div(5) // 20% to UFarm

			const perfFeeToUfarmInShares = perfFeeToUfarmInValue
				.mul(totalSupplyBeforeDeposit)
				.div(totalCostAfterRateChange)

			expect(ufarmCoreSharesAfterDeposit).to.approximately(
				ufarmPoolSharesBeforeDeposit.add(perfFeeToUfarmInShares),
				5,
				'Performance fee in shares for UFarm should be correct',
			)

			const perfFeeToFundInValue = actualPerformanceFeeInValue.mul(4).div(5) // 80% to Fund
			const perfFeeToFundInShares = perfFeeToFundInValue
				.mul(totalSupplyBeforeDeposit.add(perfFeeToUfarmInShares)) // total supply increased by UFarm perf fee payout
				.div(totalCostAfterRateChange)

			expect(fundsPoolSharesAfterDeposit).to.approximately(
				fundsPoolSharesBeforeDeposit.add(perfFeeToFundInShares),
				5,
				'Performance fee in shares for Fund should be correct',
			)
		})

		it.skip('Performance Fee is Not Calculated When There is No Profit', async () => {
			const {
				blankPool_instance,
				UnoswapV2Controller_instance,
				UFarmFund_instance,
				tokens,
				bob,
				wallet,
				UniswapV2Factory_instance,
				UniswapV2Router02_instance,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)

			let totalCost = ethers.utils.parseUnits('0', 6)
			const HWM = async () => await blankPool_instance.pool.highWaterMark()

			// Initially deposit to the pool
			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			await expect(
				UFarmFund_instance.depositToPool(
					blankPool_instance.pool.address,
					constants.ONE_HUNDRED_BUCKS,
				),
			).to.not.emit(blankPool_instance.pool, 'FeeAccrued')
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)
			totalCost = totalCost.add(constants.ONE_HUNDRED_BUCKS)

			// Conducting a swap to change pool's value
			await _poolSwapUniV2(
				blankPool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS,
				[tokens.USDT.address, tokens.WETH.address],
			)

			const totalCostAfterSwap = totalCost

			const HWMafterSwap = await HWM()

			// Adding more funds to the pool
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, constants.ONE_HUNDRED_BUCKS)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)
			totalCost = totalCost.add(constants.ONE_HUNDRED_BUCKS)

			// Ensuring no profit is made (HWM is not exceeded)
			expect(totalCost).to.eq(
				totalCostAfterSwap.add(constants.ONE_HUNDRED_BUCKS),
				'Total cost should be the same as initial cost after swap + deposit',
			)
			expect(totalCost).to.eq(
				totalCostAfterSwap.add(constants.ONE_HUNDRED_BUCKS),
				'Total cost should be the same as initial cost - exchangeFee + deposit',
			)

			expect(await HWM()).to.eq(
				HWMafterSwap.add(constants.ONE_HUNDRED_BUCKS),
				'HWM should change after swap + deposit',
			)

			const initPrice = await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				initPrice.div(2),
				wallet,
				UniswapV2Factory_instance,
			)

			const withdrawalInUSDT = constants.ONE_HUNDRED_BUCKS.div(2) // 50 USDT
			const poolExchangeRate = await blankPool_instance.pool.getExchangeRate(totalCost)
			const HWMbeforeWithdraw = await HWM()
			const withdrawalInShares = withdrawalInUSDT
				.mul(10n ** BigInt(await blankPool_instance.pool.decimals()))
				.div(poolExchangeRate) // USDT(50 * 10^6) * 10^6 / (exchangeRate * 10^6) = shares

			const fund_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: withdrawalInShares,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('fund'),
				poolAddr: blankPool_instance.pool.address,
			}

			const fund_signedWithdrawalRequest = await _signWithdrawRequest(
				blankPool_instance.pool,
				bob,
				fund_withdrawalRequest,
			)

			await UFarmFund_instance.withdrawFromPool({
				body: fund_signedWithdrawalRequest.msg,
				signature: fund_signedWithdrawalRequest.sig,
			}, tokens.USDT.address)
			const event_FeeAccrued = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.sub(withdrawalInShares)

			expect(event_FeeAccrued.args.performanceFee).to.eq(0, 'Performance fee should be 0')

			const expectedHWMafterWithdraw = HWMbeforeWithdraw.sub(withdrawalInUSDT)

			expect(await HWM()).approximately(
				expectedHWMafterWithdraw,
				1000,
				'HWM should be reduced by the withdrawn amount',
			)
		})

		it.skip('All Fees are Calculated Correctly During Withdrawal', async () => {
			const {
				blankPool_instance,
				UFarmFund_instance,
				UnoswapV2Controller_instance,
				UniswapV2Router02_instance,
				UniswapV2Factory_instance,
				wallet,
				bob,
				tokens,
				performanceCommission,
				managementCommission,
				protocolCommission,
				UFarmCore_instance,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)

			let totalCost = ethers.utils.parseUnits('0', 6)
			const updHWM = async () => {
				return blankPool_instance.pool.highWaterMark()
			}

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(20) as BigNumber

			const firstDepositTimestamp = await executeAndGetTimestamp(
				mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)
			totalCost = totalCost.add(bobsDeposit)

			const usdtToSwap = constants.ONE_HUNDRED_BUCKS.mul(10) as BigNumber
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, usdtToSwap, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			const initialETHrate = (await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)) as BigNumber

			const newETHrate = initialETHrate.mul(4).div(3) // Increase ETH price by 33%

			// await setExchangeRate(tokens.USDT.address, tokens.WETH.address, newETHrate)
			await setExchangeRate(tokens.WETH, tokens.USDT, newETHrate, wallet, UniswapV2Factory_instance)

			await time.increase(constants.Date.MONTH)

			const totalCostAfterChangingRate = totalCost

			const HWMafterDeposit = await updHWM()

			expect(HWMafterDeposit).to.eq(bobsDeposit, 'HWM should be equal to Bobs deposit')

			const allBobShares = await blankPool_instance.pool.balanceOf(bob.address)

			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: allBobShares,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: blankPool_instance.pool.address,
			}

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				blankPool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)

			await blankPool_instance.pool.connect(bob).withdraw({
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			})
			const event = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.sub(bobsDeposit)

			const feePeriod = BigNumber.from(await time.latest()).sub(firstDepositTimestamp)

			const expectedPerformanceFee = totalCostAfterChangingRate
				.sub(HWMafterDeposit)
				.mul(performanceCommission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			const expectedManagementFee = totalCostAfterChangingRate
				.mul(feePeriod)
				.mul(managementCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			const expectedProtocolFee = totalCostAfterChangingRate
				.mul(feePeriod)
				.mul(protocolCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			const totalFees = expectedPerformanceFee.add(expectedManagementFee).add(expectedProtocolFee)

			expect(event.args?.performanceFee).to.eq(
				expectedPerformanceFee,
				'Performance fee should be correct',
			)

			expect(event.args?.managementFee).to.be.closeTo(
				expectedManagementFee, 
				10, 
				'Management fee should be within ±10'
			);

			expect(event.args?.protocolFee).to.be.closeTo(
				expectedProtocolFee, 
				10, 
				'Protocol fee should be within ±10'
			);
		})
		it.skip('All Fees are Calculated Correctly During Deposit and HWM Decreases after Fee Calculation', async () => {
			const {
				blankPool_instance,
				UnoswapV2Controller_instance,
				UniswapV2Factory_instance,
				wallet,
				bob,
				tokens,
				performanceCommission,
				managementCommission,
				protocolCommission,
				UFarmCore_instance,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)

			const updHWM = async () => {
				return blankPool_instance.pool.highWaterMark()
			}

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(20) as BigNumber
			let totalCost = ethers.utils.parseUnits('0', 6)

			const firstDepositTimestamp = await executeAndGetTimestamp(
				mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)
			totalCost = totalCost.add(bobsDeposit)

			const initialHWM = await updHWM()

			const initialETHrate = (await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)) as BigNumber

			const usdtToSwap = constants.ONE_HUNDRED_BUCKS.mul(10) as BigNumber

			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, usdtToSwap, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			const newETHrate = initialETHrate.mul(3).div(2) // Increase ETH price by 33%

			await setExchangeRate(tokens.WETH, tokens.USDT, newETHrate, wallet, UniswapV2Factory_instance)

			const newEthRate = (await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)) as BigNumber

			await time.increase(constants.Date.DAY / 2)

			const totalCostAfterChangingRate = totalCost

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			const event = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.add(bobsDeposit)

			const profit = totalCostAfterChangingRate.sub(initialHWM)
			const expectedPerformanceFee = profit
				.mul(performanceCommission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			const poolConfig = await blankPool_instance.admin.getConfig() // 3E80000/65536000

			const feePeriod = BigNumber.from(await time.latest()).sub(firstDepositTimestamp)

			const expectedManagementFee = totalCostAfterChangingRate
				.mul(feePeriod)
				.mul(managementCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			const expectedProtocolFee = totalCostAfterChangingRate
				.mul(feePeriod)
				.mul(protocolCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			const totalFees = expectedPerformanceFee.add(expectedManagementFee).add(expectedProtocolFee)
			
			expect(event.args?.performanceFee).to.eq(
				expectedPerformanceFee,
				'Performance fee should be correct',
			)

			expect(event.args?.managementFee).to.be.closeTo(
				expectedManagementFee, 
				10, 
				'Management fee should be within ±10'
			);

			expect(event.args?.protocolFee).to.be.closeTo(
				expectedProtocolFee, 
				10, 
				'Protocol fee should be within ±10'
			);
			const HWMafterDeposit = await updHWM()

			expect(HWMafterDeposit).to.eq(
				totalCostAfterChangingRate.add(bobsDeposit),
				'HWM should be equal to total cost with deposit',
			)
		})

		it('deposit after deposit does not calculate performance fee', async () => {
			const { blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
				blankPoolWithRatesFixture,
			)
			let TOTAL_CONST = ethers.utils.parseUnits('0')

			async function shouldBeZeroPerformanceFee(contractTx: Promise<ContractTransaction>) {
				const depositReceipt = await (await contractTx).wait()
				const event = getEventFromReceipt(blankPool_instance.pool, depositReceipt, 'FeeAccrued')
				expect(event?.args?.performanceFee).to.eq(0, 'Performance fee should be 0')
			}

			expect(await blankPool_instance.pool.getTotalCost()).to.eq('0', 'Total cost should be 0')

			const depositAmount = constants.ONE_HUNDRED_BUCKS.mul(100000)

			// deposit from fund
			await tokens.USDT.mint(UFarmFund_instance.address, depositAmount)

			await UFarmFund_instance.depositToPool(blankPool_instance.pool.address, depositAmount),
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, TOTAL_CONST)
			TOTAL_CONST = TOTAL_CONST.add(depositAmount)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)
			await time.increase(100000)
			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, depositAmount)

			await shouldBeZeroPerformanceFee(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, depositAmount),
			)
			TOTAL_CONST = TOTAL_CONST.add(depositAmount)
			
			await time.increase(100000)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, depositAmount)
			await shouldBeZeroPerformanceFee(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, depositAmount),
			)
		})
	})

	describe("Management fee tests in Pool's", () => {
		it('Management fee should be in range of 0% - 5% while pool creation', async () => {
			const { UFarmFund_instance, poolArgs, alice } = await loadFixture(UFarmFundFixture)

			// more than max
			await expect(
				deployPool(
					{
						...poolArgs,
						managementCommission: constants.TEN_PERCENTS.add(1),
					} as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.reverted

			// more than max
			await expect(
				deployPool(
					{ ...poolArgs, managementCommission: constants.ONE } as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.reverted

			// max
			await expect(
				deployPool(
					{ ...poolArgs, managementCommission: constants.TEN_PERCENTS } as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.not.reverted

			// min
			await expect(
				deployPool(
					{ ...poolArgs, managementCommission: constants.ZERO } as PoolCreationStruct,
					UFarmFund_instance,
				),
			).to.be.not.reverted
		})
		it('Management fee should be charged after pool deposit', async () => {
			const { blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			const managementCommission = constants.TEN_PERCENTS

			await blankPool_instance.admin.setCommissions(managementCommission, constants.ZERO) // 5% of funds in time goes to fund + ufarm

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS.mul(2),
			)

			const initTimestamp = await executeAndGetTimestamp(
				UFarmFund_instance.depositToPool(
					blankPool_instance.pool.address,
					constants.ONE_HUNDRED_BUCKS,
				),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)

			const nextTimestamp = initTimestamp.add(constants.Date.YEAR) // 1 year later

			await time.setNextBlockTimestamp(nextTimestamp)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)

			const event = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS),
				blankPool_instance.pool,
				'FeeAccrued',
			)

			const expectedManagementFee = constants.ONE_HUNDRED_BUCKS.mul(managementCommission).div(
				constants.ONE,
			)

			expect(event.args?.managementFee).to.eq(
				expectedManagementFee,
				'Management fee should be correct',
			)
		})
	})
	describe('Protocol fee tests', () => {
		it("Should charge protocol fee after pool's deposit", async () => {
			const { blankPool_instance, UFarmFund_instance, UFarmCore_instance, bob, tokens, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			const protocolCommission = constants.ZERO_POINT_3_PERCENTS

			await UFarmCore_instance.setProtocolCommission(protocolCommission)

			await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS.mul(2),
			)

			const initTimestamp = await executeAndGetTimestamp(
				UFarmFund_instance.depositToPool(
					blankPool_instance.pool.address,
					constants.ONE_HUNDRED_BUCKS,
				),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS)

			const nextTimestamp = initTimestamp.add(constants.Date.YEAR) // 1 year later

			await time.setNextBlockTimestamp(nextTimestamp)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)
			const event = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS),
				blankPool_instance.pool,
				'FeeAccrued',
			)

			const expectedProtocolFee = constants.ONE_HUNDRED_BUCKS.mul(protocolCommission).div(
				constants.ONE,
			)

			expect(event.args?.protocolFee).to.eq(expectedProtocolFee, 'Protocol fee should be correct')
		})
		it('Protocol Fee and Management Fee are Calculated When There is No Change in the Pool Exchange Rate', async () => {
			const {
				blankPool_instance,
				UFarmFund_instance,
				bob,
				tokens,
				managementCommission,
				protocolCommission,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10) as BigNumber

			const firstDepositTimestamp = await executeAndGetTimestamp(
				mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			await time.increase(constants.Date.DAY * 180)

			const totalCost = bobsDeposit

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			const event = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, bobsDeposit),
				blankPool_instance.pool,
				'FeeAccrued',
			)

			const feePeriod = BigNumber.from(await time.latest()).sub(firstDepositTimestamp)

			const expectedProtocolFee = totalCost
				.mul(feePeriod)
				.mul(protocolCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			const expectedManagementFee = totalCost
				.mul(feePeriod)
				.mul(managementCommission)
				.div(constants.ONE)
				.div(constants.Date.YEAR)

			expect(event.args?.protocolFee).to.eq(expectedProtocolFee, 'Protocol fee should be correct')

			expect(event.args?.managementFee).to.eq(
				expectedManagementFee.sub(1),
				'Management fee should be correct',
			)
		})
	})
	describe('MinimumFundDeposit tests in Pool', () => {
		const minimumFundDeposit = constants.ONE_HUNDRED_BUCKS.mul(10)
		it("Pool can't be initialized if fund deposit is less than minimum", async () => {
			const { UFarmFund_instance, UFarmCore_instance, tokens, blankPool_instance, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			// Change minimum fund deposit to 1000 USDT
			await UFarmCore_instance.setMinimumFundDeposit(minimumFundDeposit)

			await tokens.USDT.mint(UFarmFund_instance.address, minimumFundDeposit)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS,
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active))
				.to.be.revertedWithCustomError(blankPool_instance.pool, 'InsufficientDepositAmount')
				.withArgs(constants.ONE_HUNDRED_BUCKS, minimumFundDeposit)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS.mul(9),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(9))

			await expect(await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)).to
				.be.not.reverted
		})

		it('Fund will be initialized if fund deposit is more than minimum', async () => {
			const { UFarmFund_instance, UFarmCore_instance, tokens, blankPool_instance, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			// Change minimum fund deposit to 1000 USDT

			await UFarmCore_instance.setMinimumFundDeposit(minimumFundDeposit)

			await tokens.USDT.mint(UFarmFund_instance.address, minimumFundDeposit)

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				minimumFundDeposit,
			)

			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				constants.ONE_HUNDRED_BUCKS.mul(10),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(10))

			await expect(await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)).to
				.be.not.reverted
		})
	})
	describe("Min and max deposit amount for investors' tests", () => {
		it("Investor can't deposit less than minimum or maximum", async () => {
			const { UFarmFund_instance, tokens, blankPool_instance, bob } = await loadFixture(
				fundWithPoolFixture,
			)

			const minimumInvestment = constants.ONE_HUNDRED_BUCKS.mul(10)
			const maximumInvestment = constants.ONE_HUNDRED_BUCKS.mul(100)

			// Change minimum fund deposit to 1000 USDT
			await blankPool_instance.admin.setInvestmentRange(minimumInvestment, maximumInvestment)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await tokens.USDT.mint(bob.address, maximumInvestment.mul(3))

			await tokens.USDT.connect(bob).approve(
				blankPool_instance.pool.address,
				maximumInvestment.mul(3),
			)

			const amountBelowMinimum = minimumInvestment.sub(1)

			await expect(blankPool_instance.pool.connect(bob).deposit(amountBelowMinimum, nullClientVerification()))
				.to.be.revertedWithCustomError(blankPool_instance.pool, 'InvalidInvestmentAmount')
				.withArgs(amountBelowMinimum, minimumInvestment, maximumInvestment)

			const amountAboveMaximum = maximumInvestment.add(1)

			await expect(blankPool_instance.pool.connect(bob).deposit(amountAboveMaximum, nullClientVerification()))
				.to.be.revertedWithCustomError(blankPool_instance.pool, 'InvalidInvestmentAmount')
				.withArgs(amountAboveMaximum, minimumInvestment, maximumInvestment)

			await expect(blankPool_instance.pool.connect(bob).deposit(minimumInvestment, nullClientVerification())).to.be.not
				.reverted
			await expect(blankPool_instance.pool.connect(bob).deposit(maximumInvestment, nullClientVerification())).to.be.not
				.reverted
		})
	})
	describe('Pool status tests', () => {
		it('Should be able to change pool status from Created to Active', async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await expect(await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active))
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Active)
		})
		it(`Should be able to change pool status from Created to Terminated`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await expect(await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated))
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Terminated)
		})
		it(`Shouldn't be able to change pool status from Created to Deactivating`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating))
				.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
				.withArgs(constants.Pool.State.Created, constants.Pool.State.Deactivating)
		})
		it('Should be able to change pool status from Deactivating to Active after withdraw fail', async () => {
			const { blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			// Set withdrawalLockup to 1 month
			const monthLockup = constants.Date.MONTH
			await blankPool_instance.admin.setLockupPeriod(monthLockup)

			// Activate pool
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			// Deposit to the pool
			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10)
			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			// Withdrawal request
			const withdrawalRequest_body = {
				sharesToBurn: bobsDeposit,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: blankPool_instance.pool.address,
			} as WithdrawRequestStruct

			const request = await _signWithdrawRequest(
				blankPool_instance.pool,
				bob,
				withdrawalRequest_body,
			)

			const requestStruct = {
				body: request.msg,
				signature: request.sig,
			}

			// Try to withdraw before lockup period is passed
			const withdrawalTimestamp = await executeAndGetTimestamp(
				blankPool_instance.pool.connect(bob).withdraw(requestStruct),
			)
			const unlockTimestamp = withdrawalTimestamp.add(monthLockup)
			await time.increaseTo(unlockTimestamp)

			await expect(blankPool_instance.pool.connect(bob).withdraw(requestStruct))
				.to.be.emit(blankPool_instance.pool, 'PoolStatusChanged')

			expect(await blankPool_instance.pool.status())
				.eq(constants.Pool.State.Deactivating)

			// Do not allow for pools with unprocessed withdrawals
			await expect(
				blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active),
			).to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
				.withArgs(constants.Pool.State.Deactivating, constants.Pool.State.Active)

			// Approve withdraw
			await expect(
				blankPool_instance.pool.approveWithdrawals([requestStruct])
			).to.be.not.reverted

			await expect(QuexCore_instance.sendResponse(blankPool_instance.pool.address, bobsDeposit))
				.to.emit(blankPool_instance.pool, 'Withdraw')

			// Allow for pools have processed withdrawals
			await expect(
				await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active),
			)
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Active)
		})
		it('Should be able to change pool status from Active to Deactivating', async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await expect(
				await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating),
			)
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Deactivating)
		})
		it('Should be able to change pool status from Deactivating to Active', async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			await expect(
				await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active),
			)
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Active)
		})
		it(`Shouldn't be able to change pool status from Active to Created or Draft`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Created))
				.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
				.withArgs(constants.Pool.State.Active, constants.Pool.State.Created)

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Draft))
				.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
				.withArgs(constants.Pool.State.Active, constants.Pool.State.Draft)
		})
		it(`Shouldn't be able to change pool status from Terminated to Active`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated)

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active))
				.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
				.withArgs(constants.Pool.State.Terminated, constants.Pool.State.Active)
		})
		it(`Should be able to change pool status from Deactivating to Terminated`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			await expect(await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated))
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Terminated)
		})
		it(`Should be able to change pool status from Deactivating to Terminated o_n_l_y`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			// Skip the Active state: it's tested in the previous testcases
			for (let i = 0; i < constants.Pool.State.Active; i++) {
				await expect(blankPool_instance.admin.changePoolStatus(i))
					.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
					.withArgs(constants.Pool.State.Deactivating, i)
			}

			await expect(
				blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating),
			).to.be.revertedWithCustomError(blankPool_instance.admin, 'ActionAlreadyDone')

			await expect(blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated))
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Terminated)
		})
		it(`Shouldn't be able to change pool status from Terminated to anything`, async () => {
			const { blankPool_instance } = await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated)

			for (let i = 0; i < constants.Pool.State.Terminated; i++) {
				await expect(blankPool_instance.admin.changePoolStatus(i))
					.to.be.revertedWithCustomError(blankPool_instance.admin, 'WrongNewPoolStatus')
					.withArgs(constants.Pool.State.Terminated, i)
			}

			await expect(
				blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated),
			).to.be.revertedWithCustomError(blankPool_instance.admin, 'ActionAlreadyDone')
		})
		it(`Shouldn't be able to use protocol functions if pool is Terminated`, async () => {
			const { blankPool_instance, UnoswapV2Controller_instance, tokens } = await loadFixture(
				fundWithPoolFixture,
			)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Terminated)

			await expect(
				_poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, constants.ONE, [
					tokens.DAI.address,
					tokens.USDC.address,
				]),
			)
				.to.be.revertedWithCustomError(blankPool_instance.pool, 'InvalidPoolStatus')
				.withArgs(constants.Pool.State.Deactivating, constants.Pool.State.Terminated)
		})
	})
	describe('Deposit requests tests', () => {
		it('Should process valid deposit request with event and deposit tokens', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const amountToInvest = constants.ONE_HUNDRED_BUCKS.mul(10).add(111)

			await tokens.USDT.mint(bob.address, amountToInvest)
			await tokens.USDT.connect(bob).approve(initialized_pool_instance.pool.address, amountToInvest)

			const depositRequest_body = {
				amountToInvest: amountToInvest,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: BigNumber.from(ethers.constants.MaxUint256)._hex,
				poolAddr: initialized_pool_instance.pool.address,
				deadline: (await time.latest()) + constants.Date.DAY,
				bearerToken: tokens.USDT.address,
			} as DepositRequestStruct

			const request = await _signDepositRequest(
				initialized_pool_instance.pool,
				bob,
				depositRequest_body,
			)

			const requestStruct = {
				body: request.msg,
				signature: request.sig,
			}

			await initialized_pool_instance.pool.approveDeposits([requestStruct])
			const tx = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			await expect(tx)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, request.hash)
				.to.changeTokenBalances(
					tokens.USDT,
					[bob, initialized_pool_instance.pool],
					[amountToInvest.mul(-1), amountToInvest],
				)
		})
		it('Should process valid deposit request with event and deposit another value tokens', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const amountToInvest = constants.ONE_HUNDRED_BUCKS.mul(10).add(111)

			await tokens.USDC.mint(bob.address, amountToInvest)
			await tokens.USDC.connect(bob).approve(initialized_pool_instance.pool.address, amountToInvest)

			const depositRequest_body = {
				amountToInvest: amountToInvest,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: BigNumber.from(ethers.constants.MaxUint256)._hex,
				poolAddr: initialized_pool_instance.pool.address,
				deadline: (await time.latest()) + constants.Date.DAY,
				bearerToken: tokens.USDC.address,
			} as DepositRequestStruct

			const request = await _signDepositRequest(
				initialized_pool_instance.pool,
				bob,
				depositRequest_body,
			)

			const requestStruct = {
				body: request.msg,
				signature: request.sig,
			}

			await initialized_pool_instance.pool.approveDeposits([requestStruct])
			const tx = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			await expect(tx)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, request.hash)
				.to.changeTokenBalances(
					tokens.USDC,
					[bob, initialized_pool_instance.pool],
					[amountToInvest.mul(-1), amountToInvest],
				)
		})
		it('Should skip deposit request with unlisted value tokens', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const amountToInvest = constants.ONE_HUNDRED_BUCKS.mul(10).add(111)

			await tokens.DAI.mint(bob.address, amountToInvest)
			await tokens.DAI.connect(bob).approve(initialized_pool_instance.pool.address, amountToInvest)

			const depositRequest_body = {
				amountToInvest: amountToInvest,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: BigNumber.from(ethers.constants.MaxUint256)._hex,
				poolAddr: initialized_pool_instance.pool.address,
				deadline: (await time.latest()) + constants.Date.DAY,
				bearerToken: tokens.DAI.address,
			} as DepositRequestStruct

			const request = await _signDepositRequest(
				initialized_pool_instance.pool,
				bob,
				depositRequest_body,
			)

			const requestStruct = {
				body: request.msg,
				signature: request.sig,
			}

			await initialized_pool_instance.pool.approveDeposits([requestStruct])
			const tx = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			await expect(tx)
				.to.changeTokenBalances(
					tokens.DAI,
					[bob, initialized_pool_instance.pool],
					[0, 0],
				)
		})
		it('Should approve many deposits requests', async () => {
			const { initialized_pool_instance, bob, tokens, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			const requests = async (iterations: number) => {
				let requestsArray: {
					msg: DepositRequestStruct
					sig: string
					hash: string
				}[] = []

				let totalSum = BigNumber.from(0)

				for (let i = 0; i < iterations; i++) {
					// Generate a random additional amount between 1 and 1000
					const randomAdditionalAmount = BigNumber.from(Math.floor(Math.random() * 1000))

					const amountToInvest = constants.ONE_HUNDRED_BUCKS.mul(10).add(randomAdditionalAmount)

					totalSum = totalSum.add(amountToInvest)

					// Generate a random salt
					const randomSalt = ethers.BigNumber.from(ethers.utils.randomBytes(32))._hex

					const depositRequest_body = {
						amountToInvest: amountToInvest,
						minOutputAmount: ethers.utils.parseUnits('0', 6),
						salt: randomSalt,
						poolAddr: initialized_pool_instance.pool.address,
						deadline: (await time.latest()) + constants.Date.DAY,
						bearerToken: tokens.USDT.address,
					} as DepositRequestStruct

					const request = await _signDepositRequest(
						initialized_pool_instance.pool,
						bob,
						depositRequest_body,
					)

					// Push the signed request into the requests array
					requestsArray.push(request)
				}

				await tokens.USDT.mint(bob.address, totalSum)
				await tokens.USDT.connect(bob).approve(initialized_pool_instance.pool.address, totalSum)

				return {
					requestsArray,
					totalSum,
				}
			}

			const { requestsArray, totalSum } = await requests(5)

			const requestsStructArray = requestsArray.map((request) => {
				return {
					body: request.msg,
					signature: request.sig,
				}
			})

			const expectedTotalShares = totalSum
				.mul(await initialized_pool_instance.pool.getExchangeRate(0))
				.div(10n ** BigInt(await initialized_pool_instance.pool.decimals()))

			await initialized_pool_instance.pool.approveDeposits(requestsStructArray)

			const tx = QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, 0)

			await expect(tx)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, requestsArray[0].hash)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, requestsArray[1].hash)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, requestsArray[2].hash)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, requestsArray[3].hash)
				.to.emit(initialized_pool_instance.pool, 'DepositRequestExecuted')
				.withArgs(bob.address, requestsArray[4].hash)
				.to.changeTokenBalances(
					tokens.USDT,
					[bob, initialized_pool_instance.pool],
					[totalSum.mul(-1), totalSum],
				)
				.to.changeTokenBalance(initialized_pool_instance.pool, bob, expectedTotalShares)
		})
		it.skip(`Should respond exchange rate change from fee`, async () => {
			const {
				blankPool_instance,
				UniswapV2Factory_instance,
				UnoswapV2Controller_instance,
				bob,
				wallet,
				tokens,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)

			const managementCommission = constants.TEN_PERCENTS
			const protocolCommission = packPerformanceCommission([
				{ step: 0, commission: (constants.Pool.Commission.ONE_HUNDRED_PERCENT / 1000) * 3 },
			])

			await blankPool_instance.admin.setCommissions(managementCommission, protocolCommission)

			const depositAmount = constants.ONE_HUNDRED_BUCKS.mul(10)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, depositAmount)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, depositAmount, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			await setExchangeRate(
				tokens.WETH,
				tokens.USDT,
				ethers.utils.parseUnits('5000', 6),
				wallet,
				UniswapV2Factory_instance,
			)

			const nextTimestamp = (await getBlockchainTimestamp(ethers.provider)) + constants.Date.YEAR // 1 year later

			await time.increaseTo(nextTimestamp)

			const balanceBeforeDeposit = await blankPool_instance.pool.balanceOf(bob.address)
			const exchangeRateBeforeDeposit = await blankPool_instance.pool.getExchangeRate(depositAmount)

			const smallDepositAmount = constants.ONE_BUCKS.mul(33)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, smallDepositAmount)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, depositAmount)
		
			const balanceAfterDeposit = await blankPool_instance.pool.balanceOf(bob.address)
			const difference = balanceAfterDeposit.sub(balanceBeforeDeposit)

			expect(difference).to.approximately(
				smallDepositAmount.mul(constants.ONE_BUCKS).div(exchangeRateBeforeDeposit),
				constants.ONE_BUCKS.div(10),
				'Shares amount should be equal to deposit amount divided by exchange rate',
			)
		})
	})
	describe('Withdraw requests tests', () => {
		describe('With withdrawalLockup', () => {
			it('Should be able to withdraw if withdrawalLockup equals 0', async () => {
				const { blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
					fundWithPoolFixture,
				)

				// Activate pool
				await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

				// Deposit to the pool
				const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10)
				await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
				await QuexCore_instance.sendResponse(blankPool_instance.pool.address, bobsDeposit)

				// Withdrawal request
				const withdrawalRequest_body = {
					sharesToBurn: bobsDeposit,
					minOutputAmount: ethers.utils.parseUnits('0', 6),
					salt: protocolToBytes32('bob'),
					poolAddr: blankPool_instance.pool.address,
				} as WithdrawRequestStruct

				const request = await _signWithdrawRequest(
					blankPool_instance.pool,
					bob,
					withdrawalRequest_body,
				)

				const requestStruct = {
					body: request.msg,
					signature: request.sig,
				}

				await expect(blankPool_instance.pool.connect(bob).withdraw(requestStruct)).to.be.not
					.reverted
			})
			it("Shouldn't be able to withdraw if withdrawalLockup is not passed", async () => {
				const { blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance } = await loadFixture(
					fundWithPoolFixture,
				)

				// Set withdrawalLockup to 1 month
				const monthLockup = constants.Date.MONTH
				await blankPool_instance.admin.setLockupPeriod(monthLockup)

				// Activate pool
				await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

				// Deposit to the pool
				const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10)
				await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
				await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

				// Withdrawal request
				const withdrawalRequest_body = {
					sharesToBurn: bobsDeposit,
					minOutputAmount: ethers.utils.parseUnits('0', 6),
					salt: protocolToBytes32('bob'),
					poolAddr: blankPool_instance.pool.address,
				} as WithdrawRequestStruct

				const request = await _signWithdrawRequest(
					blankPool_instance.pool,
					bob,
					withdrawalRequest_body,
				)

				const requestStruct = {
					body: request.msg,
					signature: request.sig,
				}

				// Try to withdraw before lockup period is passed
				const withdrawalTimestamp = await executeAndGetTimestamp(
					blankPool_instance.pool.connect(bob).withdraw(requestStruct),
				)

				const unlockTimestamp = withdrawalTimestamp.add(monthLockup)

				await expect(blankPool_instance.pool.connect(bob).withdraw(requestStruct))
					.to.be.revertedWithCustomError(blankPool_instance.pool, 'LockupPeriodNotPassed')
					.withArgs(unlockTimestamp)

				await time.increaseTo(unlockTimestamp)

				await expect(blankPool_instance.pool.connect(bob).withdraw(requestStruct))
					.to.be.emit(blankPool_instance.pool, 'PoolStatusChanged')

				expect(await blankPool_instance.pool.status())
					.eq(constants.Pool.State.Deactivating)
			})
		})
		it("Shouldn't be able to withdraw more USDT than is available in deactivating state", async () => {
			const { UFarmCore_instance, blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance, UnoswapV2Controller_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			const FIVE_HUNDRED_BUCKS = ethers.utils.parseUnits('500', 6)
			const TWO_HUNDRED_BUCKS = ethers.utils.parseUnits('200', 6)


			// Deposit to the pool
			await tokens.USDT.mint(UFarmFund_instance.address, FIVE_HUNDRED_BUCKS)

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				FIVE_HUNDRED_BUCKS,
			)
			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				FIVE_HUNDRED_BUCKS,
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			// Activate pool
			await UFarmCore_instance.setMinimumFundDeposit(constants.ONE_HUNDRED_BUCKS)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = ethers.utils.parseUnits('1000', 6)
			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, FIVE_HUNDRED_BUCKS)

			// Swap to WETH
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, TWO_HUNDRED_BUCKS, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			// Deactivate pool
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Deactivating)

			// Withdrawal request
			const withdrawalRequestFailed_body = {
				sharesToBurn: FIVE_HUNDRED_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('fundFailed'),
				poolAddr: blankPool_instance.pool.address,
			} as WithdrawRequestStruct

			const failedRequestStruct = {
				body: withdrawalRequestFailed_body,
				signature: ethers.utils.toUtf8Bytes(''),
			}

			const withdrawalRequest_body = {
				sharesToBurn: TWO_HUNDRED_BUCKS,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('fund'),
				poolAddr: blankPool_instance.pool.address,
			} as WithdrawRequestStruct

			const requestStruct = {
				body: withdrawalRequest_body,
				signature: ethers.utils.toUtf8Bytes(''),
			}
			
			await UFarmFund_instance.withdrawFromPool(failedRequestStruct, tokens.USDT.address)
			await expect(QuexCore_instance.sendResponse(blankPool_instance.pool.address, FIVE_HUNDRED_BUCKS.add(bobsDeposit)))
				.to.changeTokenBalance(
					tokens.USDT,
					UFarmFund_instance,
					0,
				)
				.to.not.emit(blankPool_instance.pool, 'Withdraw')

			await UFarmFund_instance.withdrawFromPool(requestStruct, tokens.USDT.address)
			await expect(QuexCore_instance.sendResponse(blankPool_instance.pool.address, FIVE_HUNDRED_BUCKS.add(bobsDeposit)))
				.to.emit(blankPool_instance.pool, 'Withdraw')
				.to.changeTokenBalance(
					tokens.USDT,
					UFarmFund_instance,
					TWO_HUNDRED_BUCKS,
				)
		})
		it("Should deactivate pool", async () => {
			const { UFarmCore_instance, blankPool_instance, UFarmFund_instance, bob, tokens, QuexCore_instance, UnoswapV2Controller_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			const ONE_THOUSAND_BUCKS = ethers.utils.parseUnits('1000', 6)
			const TWO_THOUSAND_BUCKS = ethers.utils.parseUnits('2000', 6)

			const monthLockup = constants.Date.MONTH
			await blankPool_instance.admin.setLockupPeriod(monthLockup)

			// Deposit to the pool
			await tokens.USDT.mint(UFarmFund_instance.address, ONE_THOUSAND_BUCKS)

			await UFarmFund_instance.approveAssetTo(
				tokens.USDT.address,
				blankPool_instance.pool.address,
				ONE_THOUSAND_BUCKS,
			)
			await UFarmFund_instance.depositToPool(
				blankPool_instance.pool.address,
				ONE_THOUSAND_BUCKS,
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			// Activate pool
			await UFarmCore_instance.setMinimumFundDeposit(constants.ONE_HUNDRED_BUCKS)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, ONE_THOUSAND_BUCKS)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, ONE_THOUSAND_BUCKS)

			// Swap to WETH
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, TWO_THOUSAND_BUCKS, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			const bobShares = await blankPool_instance.pool.balanceOf(bob.address)
			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: bobShares,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: blankPool_instance.pool.address,
			}

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				blankPool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)

			const bob_withdrawal: SignedWithdrawRequestStruct = {
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			}

			await expect(blankPool_instance.pool.connect(bob).withdraw(bob_withdrawal))
				.to.not.emit(blankPool_instance.pool, 'PoolStatusChanged')



			await time.increase(constants.Date.MONTH)

			await expect(blankPool_instance.pool.connect(bob).withdraw(bob_withdrawal))
				.to.emit(blankPool_instance.pool, 'PoolStatusChanged')
				.withArgs(constants.Pool.State.Deactivating)

			expect(await blankPool_instance.pool.status())
				.eq(constants.Pool.State.Deactivating)
		})
		it('Should portion withdraw two requests without confirmation', async () => {
			const { blankPool_instance, UnoswapV2Controller_instance, bob, tokens, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			// Activate pool
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			// Deposit to the pool
			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10)
			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, bobsDeposit)

			// Swap to WETH
			const usdtToSwap = constants.ONE_HUNDRED_BUCKS.mul(3) as BigNumber
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, usdtToSwap, [
				tokens.USDT.address,
				tokens.WETH.address,
			])
			// Swap to USDC
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, usdtToSwap, [
				tokens.USDT.address,
				tokens.USDC.address,
			])

			// Withdrawal request
			const withdrawalRequest1 = await prepareWithdrawRequest(
				bob,
				blankPool_instance.pool,
				bobsDeposit.div(2),
			)
			const withdrawalRequest2 = await prepareWithdrawRequest(
				bob,
				blankPool_instance.pool,
				bobsDeposit.div(2),
			)
			await expect(
				blankPool_instance.pool.approveWithdrawals([withdrawalRequest1, withdrawalRequest2]),
			).to.be.not.reverted
		})
	})
	describe('Math tests', () => {
		it.skip('Total Fee is Distributed Correctly Between the Fund and the UFarm', async () => {
			const {
				blankPool_instance,
				UFarmCore_instance,
				bob,
				tokens,
				performanceCommission,
				managementCommission,
				protocolCommission,
				UniswapV2Factory_instance,
				UniswapV2Router02_instance,
				wallet,
				QuexCore_instance
			} = await loadFixture(blankPoolWithRatesFixture)
			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(20) as BigNumber
			let totalCost = ethers.utils.parseUnits('0', 6)

			const firstDepositTimestamp = await executeAndGetTimestamp(
				mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)
			totalCost = totalCost.add(bobsDeposit)

			const initialETHrate = (await getPriceRate(
				tokens.WETH.address,
				tokens.USDT.address,
				UniswapV2Factory_instance,
			)) as BigNumber

			const usdtToSwap = constants.ONE_HUNDRED_BUCKS.mul(10) as BigNumber

			await blankPool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				encodePoolSwapDataUniswapV2(
					usdtToSwap,
					twoPercentLose(usdtToSwap),
					(await time.latest()) + 10,
					[tokens.USDT.address, tokens.WETH.address],
				),
			)

			const newETHrate = initialETHrate.mul(4).div(3) // Increase ETH price by 33%

			await setExchangeRate(tokens.WETH, tokens.USDT, newETHrate, wallet, UniswapV2Factory_instance)

			await time.increase(constants.Date.DAY * 30)

			const totalCostAfterChangingRate = totalCost

			const HWMafterChangingRate = await blankPool_instance.pool.highWaterMark()

			const totalSupplyBeforeDeposit = await blankPool_instance.pool.totalSupply()

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit)
			const event_FeeAccrued = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalCost),
				blankPool_instance.pool,
				'FeeAccrued',
			)
			totalCost = totalCost.add(bobsDeposit)
			const totalCostAfterDeposit = totalCost

			const expectedPerformanceFee = totalCostAfterChangingRate
				.sub(HWMafterChangingRate)
				.mul(performanceCommission)
				.div(constants.Pool.Commission.ONE_HUNDRED_PERCENT)

			const feePeriod = BigNumber.from(await time.latest()).sub(firstDepositTimestamp)

			const costInTimeCalculated = totalCostAfterChangingRate
				.mul(feePeriod)
				.div(constants.Date.YEAR)

			const expectedManagementFee = costInTimeCalculated
				.mul(managementCommission)
				.div(constants.ONE)

			const expectedProtocolFee = costInTimeCalculated.mul(protocolCommission).div(constants.ONE)

			const expectedFundFee = expectedManagementFee.add(expectedPerformanceFee).mul(4).div(5) // 80% of management fee and performance fee

			const expectedUFarmFee = expectedFundFee.div(4).add(expectedProtocolFee) // 20% of management fee and performance fee

			const expectedUFarmShares = expectedUFarmFee
				.mul(totalSupplyBeforeDeposit)
				.div(totalCostAfterChangingRate)

			const expectedFundShares = expectedFundFee
				.mul(totalSupplyBeforeDeposit.add(expectedUFarmShares))
				.div(totalCostAfterChangingRate)

			expect(event_FeeAccrued.args?.sharesToUFarm).to.eq(
				expectedUFarmShares,
				'UFarm fee shares should be correct',
			)

			expect(event_FeeAccrued.args?.sharesToFund).to.be.closeTo(
				expectedFundShares, 
				10, 
				'Fund fee shares should be within ±10'
			);
		})

		it("Full Withdrawal After 1 Year of Pool's Existence", async () => {
			const { blankPool_instance, UFarmFund_instance, UFarmCore_instance, bob, tokens, QuexCore_instance } =
				await loadFixture(blankPoolWithRatesFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const bobsDeposit = constants.ONE_HUNDRED_BUCKS.mul(10) as BigNumber

			// Bob mints and deposits 1000 USDT
			const firstDepositTimestamp = await executeAndGetTimestamp(
				mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, bobsDeposit),
			)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, 0)

			expect(await blankPool_instance.pool.balanceOf(bob.address)).to.eq(
				bobsDeposit,
				'Bob should have 1000.000000 shares',
			)

			// Swap 500 USDT to WETH
			await blankPool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				encodePoolSwapDataUniswapV2(
					bobsDeposit.div(2),
					twoPercentLose(bobsDeposit.div(2)),
					(await time.latest()) + 1,
					[tokens.USDT.address, tokens.WETH.address],
				),
			)

			// Year later
			await time.increase(constants.Date.YEAR)

			const bob_withdrawalRequest: WithdrawRequestStruct = {
				sharesToBurn: bobsDeposit,
				minOutputAmount: ethers.utils.parseUnits('0', 6),
				salt: protocolToBytes32('bob'),
				poolAddr: blankPool_instance.pool.address,
			}

			const bob_signedWithdrawalRequest = await _signWithdrawRequest(
				blankPool_instance.pool,
				bob,
				bob_withdrawalRequest,
			)

			const bob_withdrawal: SignedWithdrawRequestStruct = {
				body: bob_signedWithdrawalRequest.msg,
				signature: bob_signedWithdrawalRequest.sig,
			}

			// save snapshot
			let beforeWithdraw = await takeSnapshot()

			const totalSupplyBeforeMintingFee = await blankPool_instance.pool.totalSupply()

			await blankPool_instance.pool.connect(bob).withdraw(bob_withdrawal)
			const feeAccruedEvent = await getEventFromTx(
				QuexCore_instance.sendResponse(blankPool_instance.pool.address, bobsDeposit),
				blankPool_instance.pool,
				'FeeAccrued',
			)

			const [ufarmShares, fundShares] = [
				feeAccruedEvent.args.sharesToUFarm as BigNumber,
				feeAccruedEvent.args.sharesToFund as BigNumber,
			]

			await beforeWithdraw.restore()
		})
	})
	describe.skip('Gas consume tests', () => {
		it(`Should be able to withdraw after 10 mints of the UniswapV3 position`, async () => {
			const { blankPool_instance, UnoswapV2Controller_instance, UFarmCore_instance, bob, tokens, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			await blankPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

			const totalPoolDeposit = constants.ONE_HUNDRED_BUCKS.mul(200) // $20.000

			await mintAndDeposit(blankPool_instance.pool, tokens.USDT, bob, totalPoolDeposit)
			await QuexCore_instance.sendResponse(blankPool_instance.pool.address, totalPoolDeposit)

			// prepare ETH for positions
			const roundedEthWorth = constants.ONE_HUNDRED_BUCKS.mul(100) // $10.000
			await _poolSwapUniV2(blankPool_instance.pool, UnoswapV2Controller_instance, roundedEthWorth, [
				tokens.USDT.address,
				tokens.WETH.address,
			])

			const USDT_left = totalPoolDeposit.sub(roundedEthWorth)

			const currentRate = constants.ONE_HUNDRED_BUCKS.mul(2000)

			const desiredUSDTAmountTotal = USDT_left
			const desiredETHAmountTotal = convertDecimals(desiredUSDTAmountTotal, 6, 18)
				.mul(currentRate)
				.div(BigInt(10 ** 6))

			const maxI = 5
			for (let i = 0; i < maxI; i++) {
				const mintData: INonfungiblePositionManager.MintParamsStruct = {
					token0: tokens.USDT.address,
					token1: tokens.WETH.address,
					fee: 3000,
					tickLower: nearestUsableTick(constants.UniV3.MIN_TICK, 3000),
					tickUpper: nearestUsableTick(constants.UniV3.MAX_TICK, 3000),
					amount0Desired: desiredUSDTAmountTotal.div(maxI),
					amount1Desired: desiredETHAmountTotal.div(maxI),
					amount0Min: BigNumber.from(10),
					amount1Min: BigNumber.from(1000),
					recipient: blankPool_instance.pool.address,
					deadline: BigNumber.from((await time.latest()) + 1),
				}
				const encodedMintData = encodePoolMintPositionUniV3(mintData)

				const actionResponse = await blankPool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodedMintData,
				)
				const actionReceipt = await actionResponse.wait()
				console.log(`Minted ${i + 1} positions, gas used: ${actionReceipt.gasUsed.toString()}`)
			}

			const bobShares = await blankPool_instance.pool.balanceOf(bob.address)

			for (let i = 0; i < 3; i++) {
				// Withdraw in 3 parts
				const withdrawRequest = {
					sharesToBurn: bobShares.div(3),
					minOutputAmount: ethers.utils.parseUnits('0', 6),
					salt: protocolToBytes32(`bob${i}`),
					poolAddr: blankPool_instance.pool.address,
				}

				const signedWithdrawRequest = await _signWithdrawRequest(
					blankPool_instance.pool,
					bob,
					withdrawRequest,
				)

				const withdrawRequestStruct = {
					body: signedWithdrawRequest.msg,
					signature: signedWithdrawRequest.sig,
				}

				const estimatedGas = await blankPool_instance.pool.estimateGas.withdraw(
					withdrawRequestStruct,
				)
				// console.log(`Estimated gas: ${estimatedGas.toString()}`)

				const response = await blankPool_instance.pool.connect(bob).withdraw(withdrawRequestStruct)
				const receipt = await response.wait()

				console.log(`Gas used during withdrawal: ${receipt.gasUsed.toString()}`)
			}
		}).timeout(199999999999)
	})
})

describe('Pool periphery contracts tests', () => {
	describe('UnoswapV3Controller', () => {
		it('Should be able to swap tokens using UniswapV3 single pair', async () => {
			const { tokens, initialized_pool_instance, bob, quoter_instance, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(10),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(10))

			const quote = await quoteMaxSlippageSingle(quoter_instance, {
				tokenIn: tokens.USDT.address,
				tokenOut: tokens.WETH.address,
				amountIn: constants.ONE_HUNDRED_BUCKS,
				fee: 3000,
				sqrtPriceLimitX96: 0,
			})

			const encodedSwapData = encodePoolSwapUniV3SingleHopExactInput(
				tokens.USDT.address,
				tokens.WETH.address,
				3000,
				initialized_pool_instance.pool.address,
				(await time.latest()) + 10,
				constants.ONE_HUNDRED_BUCKS,
				quote.amountOut,
				quote.sqrtPriceX96After,
			)

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV3ProtocolString,
				encodedSwapData,
			)

			expect(await tokens.WETH.balanceOf(initialized_pool_instance.pool.address)).to.eq(
				quote.amountOut,
			)
		})
		it('Should be able to swap tokens using UniswapV3 multihop', async () => {
			const { tokens, initialized_pool_instance, bob, quoter_instance, QuexCore_instance } = await loadFixture(
				fundWithPoolFixture,
			)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(10),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(10))

			const path = uniV3_tokensFeesToPath([
				tokens.USDT.address,
				3000,
				tokens.WETH.address,
				3000,
				tokens.DAI.address,
			])

			const quote = await quoter_instance.callStatic.quoteExactInput(
				path,
				constants.ONE_HUNDRED_BUCKS,
			)

			const encodedSwapData = encodePoolSwapUniV3MultiHopExactInput(
				[tokens.USDT.address, 3000, tokens.WETH.address, 3000, tokens.DAI.address],
				initialized_pool_instance.pool.address,
				(await time.latest()) + 10,
				constants.ONE_HUNDRED_BUCKS,
				quote.amountOut,
			)

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV3ProtocolString,
				encodedSwapData,
			)
		})
		it("Should be able to add liquidity to UniswapV3's pool and keep totalCost", async () => {
			const {
				tokens,
				initialized_pool_instance,
				bob,
				UnoswapV2Controller_instance,
				UnoswapV3Controller_instance,
				nonFungPosManager_instance,
				uniswapV3Factory_instance,
				quoter_instance,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(24),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(24))

			await _poolSwapUniV2(
				initialized_pool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS.mul(10),
				[tokens.USDT.address, tokens.WETH.address],
			)

			const pairv3_addr = await uniswapV3Factory_instance.getPool(
				tokens.USDT.address,
				tokens.WETH.address,
				3000,
			)
			const pairv3 = (await ethers.getContractAt(
				'@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool',
				pairv3_addr,
			)) as IUniswapV3Pool

			const quoteUSDTWETH = await quoteMaxSlippageSingle(quoter_instance, {
				tokenIn: tokens.USDT.address,
				tokenOut: tokens.WETH.address,
				amountIn: constants.ONE_HUNDRED_BUCKS,
				fee: 3000,
				sqrtPriceLimitX96: 0,
			})

			const encodedSwapData = async () => {
				return encodePoolSwapUniV3SingleHopExactInput(
					tokens.USDT.address,
					tokens.WETH.address,
					3000,
					initialized_pool_instance.pool.address,
					(await time.latest()) + 10,
					constants.ONE_HUNDRED_BUCKS.div(6),
					10,
					quoteUSDTWETH.sqrtPriceX96After,
				)
			}

			{
				// Generate history
				for (let i = 0; i < 5; i++) {
					await initialized_pool_instance.pool.protocolAction(
						constants.UFarm.prtocols.UniswapV3ProtocolString,
						await encodedSwapData(),
					)

					await time.increase(500)
				}
			}

			const WETH_balance = await tokens.WETH.balanceOf(initialized_pool_instance.pool.address)

			const reversed = (await pairv3.token0()) === tokens.USDT.address

			const USDT_to_spent = constants.ONE_HUNDRED_BUCKS.mul(13)

			const mintData: INonfungiblePositionManager.MintParamsStruct = {
				token0: reversed ? tokens.USDT.address : tokens.WETH.address,
				token1: reversed ? tokens.WETH.address : tokens.USDT.address,
				fee: 3000,
				tickLower: nearestUsableTick(constants.UniV3.MIN_TICK, 3000),
				tickUpper: nearestUsableTick(constants.UniV3.MAX_TICK, 3000),
				amount0Desired: reversed ? USDT_to_spent : WETH_balance,
				amount1Desired: reversed ? WETH_balance : USDT_to_spent,
				amount0Min: BigNumber.from(1000),
				amount1Min: BigNumber.from(1000),
				recipient: initialized_pool_instance.pool.address,
				deadline: BigNumber.from((await time.latest()) + 10),
			}
			const totalCostBeforeMint = await initialized_pool_instance.pool.getTotalCost()

			const encodedMintData = encodePoolMintPositionUniV3(mintData)

			let nextNFPMTokenId: BigNumber = BigNumber.from(1)

			while (true) {
				try {
					// Not reverts if position exists
					await nonFungPosManager_instance.positions(nextNFPMTokenId)
					nextNFPMTokenId = nextNFPMTokenId.add(1)
				} catch (error) {
					break
				}
			}

			const PositionMinted_event = await getEventFromTx(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodedMintData,
				),
				UnoswapV3Controller_instance,
				'PositionMintedUnoV3',
			)
			expect({
				token0: PositionMinted_event.args?.token0,
				token1: PositionMinted_event.args?.token1,
				tokenAddr: PositionMinted_event.args?.tokenAddr,
				fee: PositionMinted_event.args?.fee,
				tickLower: PositionMinted_event.args?.tickLower,
				tickUpper: PositionMinted_event.args?.tickUpper,
				tokenId: PositionMinted_event.args?.tokenId,
			}).to.deep.eq(
				{
					token0: mintData.token0,
					token1: mintData.token1,
					tokenAddr: nonFungPosManager_instance.address,
					fee: mintData.fee,
					tickLower: mintData.tickLower,
					tickUpper: mintData.tickUpper,
					tokenId: nextNFPMTokenId,
				},
				'PositionMintedUnoV3 event should be correct',
			)

			const totalCostAfterMint = await initialized_pool_instance.pool.getTotalCost()

			expect(totalCostAfterMint).to.approximately(
				totalCostBeforeMint,
				10000,
				'Total cost should be the same after minting',
			) // 1 wei for rounding

			expect(await nonFungPosManager_instance.ownerOf(nextNFPMTokenId)).to.eq(
				initialized_pool_instance.pool.address,
				'Position should be owned by the pool',
			)
		})
		it("Should add and burn liquidity from UniswapV3's pool", async () => {
			const {
				tokens,
				initialized_pool_instance,
				bob,
				UnoswapV3Controller_instance,
				UnoswapV2Controller_instance,
				nonFungPosManager_instance,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(23),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(23))

			await _poolSwapUniV2(
				initialized_pool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS.mul(10),
				[tokens.USDT.address, tokens.WETH.address],
			)

			const WETH_balance = await tokens.WETH.balanceOf(initialized_pool_instance.pool.address)

			const mintData: INonfungiblePositionManager.MintParamsStruct = {
				token0: tokens.USDT.address,
				token1: tokens.WETH.address,
				fee: 3000,
				tickLower: nearestUsableTick(constants.UniV3.MIN_TICK, 3000),
				tickUpper: nearestUsableTick(constants.UniV3.MAX_TICK, 3000),
				amount0Desired: constants.ONE_HUNDRED_BUCKS.mul(13),
				amount1Desired: WETH_balance,
				amount0Min: BigNumber.from(1000),
				amount1Min: BigNumber.from(1000),
				recipient: initialized_pool_instance.pool.address,
				deadline: BigNumber.from((await time.latest()) + 10),
			}

			const encodedMintData = encodePoolMintPositionUniV3(mintData)

			let nextNFPMTokenId: BigNumber = BigNumber.from(1)

			while (true) {
				try {
					// Not reverts if position exists
					await nonFungPosManager_instance.positions(nextNFPMTokenId)
					nextNFPMTokenId = nextNFPMTokenId.add(1)
				} catch (error) {
					break
				}
			}

			const mintEvent = await getEventFromTx(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodedMintData,
				),
				UnoswapV3Controller_instance,
				'PositionMintedUnoV3',
			)

			const [positionId, positionLiquidity, positionAmount0, positionAmount1] = [
				mintEvent.args.tokenId as BigNumber,
				mintEvent.args.liquidityMinted as BigNumber,
				mintEvent.args.amount0 as BigNumber,
				mintEvent.args.amount1 as BigNumber,
			]

			const burnData: INonfungiblePositionManager.DecreaseLiquidityParamsStruct = {
				tokenId: positionId,
				liquidity: positionLiquidity,
				amount0Min: BigNumber.from(1000),
				amount1Min: BigNumber.from(1000),
				deadline: BigNumber.from((await time.latest()) + 10),
			}

			const encodedBurnData = encodeBurnPositionUniV3(burnData)

			const burnPositionEvent = await getEventFromTx(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodedBurnData,
				),
				UnoswapV3Controller_instance,
				'PositionBurnedUnoV3',
			)

			// add tests
		})
		it("Should claim uncollected fees from UniswapV3's position", async () => {
			const {
				tokens,
				initialized_pool_instance,
				bob,
				UnoswapV3Controller_instance,
				uniswapV3Factory_instance,
				UnoswapV2Controller_instance,
				PriceOracle_instance,
				nonFungPosManager_instance,
				quoter_instance,
				uniswapv3Router_instance,
				QuexCore_instance
			} = await loadFixture(fundWithPoolFixture)

			async function generateFees() {
				for (let i = 0; i < 4; i++) {
					const amountIn = constants.ONE_HUNDRED_BUCKS.mul(10000)

					const quoteUSDT_ETH = await quoteMaxSlippageSingle(quoter_instance, {
						tokenIn: tokens.USDT.address,
						tokenOut: tokens.WETH.address,
						amountIn: amountIn,
						fee: 3000,
						sqrtPriceLimitX96: 0,
					})

					const amountETHmin = quoteUSDT_ETH.amountOut

					// buy WETH
					await mintTokens(tokens.USDT, amountIn, bob)
					await safeApprove(tokens.USDT, uniswapv3Router_instance.address, amountIn, bob)
					await uniswapv3Router_instance.connect(bob).exactInputSingle({
						tokenIn: tokens.USDT.address,
						tokenOut: tokens.WETH.address,
						fee: 3000,
						recipient: bob.address,
						deadline: (await time.latest()) + 10,
						amountIn: amountIn,
						amountOutMinimum: amountETHmin,
						sqrtPriceLimitX96: quoteUSDT_ETH.sqrtPriceX96After,
					})

					await time.increase(500)
					const amountETHequivalent = amountETHmin.mul(10000).div(9995)
					// Buy USDT
					const quoteETH_USDT = await quoteMaxSlippageSingle(quoter_instance, {
						tokenIn: tokens.WETH.address,
						tokenOut: tokens.USDT.address,
						amountIn: amountETHequivalent,
						fee: 3000,
						sqrtPriceLimitX96: 0,
					})
					const amountUSDTmin = quoteETH_USDT.amountOut
					await mintTokens(tokens.WETH, amountETHequivalent, bob)
					await safeApprove(
						tokens.WETH.connect(bob),
						uniswapv3Router_instance.address,
						amountETHequivalent,
						bob,
					)
					await uniswapv3Router_instance.connect(bob).exactInputSingle({
						tokenIn: tokens.WETH.address,
						tokenOut: tokens.USDT.address,
						fee: 3000,
						recipient: bob.address,
						deadline: (await time.latest()) + 10,
						amountIn: amountETHequivalent,
						amountOutMinimum: amountUSDTmin,
						sqrtPriceLimitX96: quoteETH_USDT.sqrtPriceX96After,
					})
				}
			}

			await generateFees()

			const usdtIs0 = BigInt(tokens.USDT.address) < BigInt(tokens.WETH.address)

			// Deposit to the position holder pool
			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(23),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(23))

			await _poolSwapUniV2(
				initialized_pool_instance.pool,
				UnoswapV2Controller_instance,
				constants.ONE_HUNDRED_BUCKS.mul(10),
				[tokens.USDT.address, tokens.WETH.address],
			)

			const WETH_balance = await tokens.WETH.balanceOf(initialized_pool_instance.pool.address)
			const USDT_balance = await tokens.USDT.balanceOf(initialized_pool_instance.pool.address)

			const mintData: INonfungiblePositionManager.MintParamsStruct = {
				token0: tokens.USDT.address,
				token1: tokens.WETH.address,
				fee: 3000,
				tickLower: nearestUsableTick(constants.UniV3.MIN_TICK, 3000),
				tickUpper: nearestUsableTick(constants.UniV3.MAX_TICK, 3000),
				amount0Desired: USDT_balance,
				amount1Desired: WETH_balance,
				amount0Min: BigNumber.from(1000),
				amount1Min: BigNumber.from(1000),
				recipient: initialized_pool_instance.pool.address,
				deadline: BigNumber.from((await time.latest()) + 10),
			}

			const encodedMintData = encodePoolMintPositionUniV3(mintData)

			const mintEvent = await getEventFromTx(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodedMintData,
				),
				UnoswapV3Controller_instance,
				'PositionMintedUnoV3',
			)

			const [positionId, positionLiquidity, positionAmount0, positionAmount1] = [
				mintEvent.args.tokenId as BigNumber,
				mintEvent.args.liquidityMinted as BigNumber,
				mintEvent.args.amount0 as BigNumber,
				mintEvent.args.amount1 as BigNumber,
			]

			const positionAmountsWithoutFees = await UnoswapV3Controller_instance.getAmountsFromPosition(
				positionId,
			)

			await generateFees()

			const snaphotAfter1Second = await takeSnapshot()

			await time.increase(1)

			const costOfPoolWithLpWithFees = await initialized_pool_instance.pool.getTotalCost()

			await snaphotAfter1Second.restore()

			// pending fees

			const positionAmountsWithFees = await UnoswapV3Controller_instance.getAmountsFromPosition(
				positionId,
			)

			expect(positionAmountsWithFees.feeAmount0).to.be.gt(0, 'Fee amount0 should be greater than 0')
			expect(positionAmountsWithFees.feeAmount1).to.be.gt(0, 'Fee amount1 should be greater than 0')

			const maxUINT128 = BigNumber.from(2).pow(128).sub(1)
			await expect(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV3ProtocolString,
					encodeCollectFeesUniV3({
						tokenId: positionId,
						recipient: initialized_pool_instance.pool.address,
						amount0Max: maxUINT128,
						amount1Max: maxUINT128,
					}),
				),
			)
				.to.changeTokenBalance(
					tokens.USDT,
					initialized_pool_instance.pool,
					usdtIs0 ? positionAmountsWithFees.feeAmount0 : positionAmountsWithFees.feeAmount1,
				)
				.to.changeTokenBalance(
					tokens.WETH,
					initialized_pool_instance.pool,
					usdtIs0 ? positionAmountsWithFees.feeAmount1 : positionAmountsWithFees.feeAmount0,
				)
				.to.emit(nonFungPosManager_instance, 'Collect')
				.withArgs(
					positionId,
					initialized_pool_instance.pool.address,
					positionAmountsWithFees.feeAmount0,
					positionAmountsWithFees.feeAmount1,
				)
				.to.emit(
					await ethers.getContractAt(
						'UniswapV3ControllerArbitrum',
						initialized_pool_instance.pool.address,
					),
					'FeesCollectedUnoV3',
				)
				.withArgs(
					nonFungPosManager_instance.address,
					usdtIs0 ? tokens.USDT.address : tokens.WETH.address,
					usdtIs0 ? tokens.WETH.address : tokens.USDT.address,
					initialized_pool_instance.pool.address,
					positionId,
					positionAmountsWithFees.feeAmount0,
					positionAmountsWithFees.feeAmount1,
					constants.UFarm.prtocols.UniswapV3ProtocolString,
				)

			const costOfPoolWithClaimedFees = await initialized_pool_instance.pool.getTotalCost()



			const positionAfterFees = await UnoswapV3Controller_instance.getAmountsFromPosition(
				positionId,
			)

			expect(costOfPoolWithLpWithFees).to.approximately(
				costOfPoolWithClaimedFees,
				10,
				'Cost of pool should be the same',
			)
		})
	})
	describe('UnoswapV2Controller', () => {
		async function depositAndSwap(
			pool_instanceWithManager: UFarmPool,
			unoswapV2Controller: UnoswapV2Controller,
			investor: SignerWithAddress,
			amountToMintAndSwap: BigNumber,
			depositToken: StableCoin,
			swapTo: StableCoin,
			quexCore: QuexCore | null = null,
		) {
			await mintAndDeposit(pool_instanceWithManager, depositToken, investor, amountToMintAndSwap)
			
			if(quexCore) {
				await quexCore.sendResponse(pool_instanceWithManager.address, amountToMintAndSwap)
			}

			await _poolSwapUniV2(pool_instanceWithManager, unoswapV2Controller, amountToMintAndSwap, [
				depositToken.address,
				swapTo.address,
			])
		}
		it("Should swap tokens using UnoswapV2Controller's swap function", async () => {
			const { tokens, initialized_pool_instance, bob, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(10),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(10))

			const calldata = encodePoolSwapDataUniswapV2(
				constants.ONE_HUNDRED_BUCKS,
				constants.ONE_HUNDRED_BUCKS.div(2),
				BigNumber.from((await time.latest()) + 10),
				[tokens.USDT.address, tokens.DAI.address],
			)

			const daiBalanceBefore = await tokens.DAI.balanceOf(initialized_pool_instance.pool.address)

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				calldata,
			)

			const daiBalanceAfter = await tokens.DAI.balanceOf(initialized_pool_instance.pool.address)

			expect(daiBalanceAfter.sub(daiBalanceBefore)).to.be.greaterThanOrEqual(
				constants.ONE_HUNDRED_BUCKS.div(2),
			)
		})

		it('Should receive precomputed liquidity amount', async () => {
			const { tokens, initialized_pool_instance, UnoswapV2Controller_instance, bob, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			await depositAndSwap(
				initialized_pool_instance.pool,
				UnoswapV2Controller_instance,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(10),
				tokens.USDT,
				tokens.DAI,
				QuexCore_instance
			)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(2),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			const [usdtDecimals, daiDecimals] = await Promise.all([
				tokens.USDT.decimals(),
				tokens.DAI.decimals(),
			])
			const USDTamount = constants.ONE_HUNDRED_BUCKS
			const DAIamount = convertDecimals(constants.ONE_HUNDRED_BUCKS, usdtDecimals, daiDecimals)
			const addLiquidityCalldata = encodePoolAddLiqudityDataAsIsUniswapV2(
				tokens.DAI.address,
				tokens.USDT.address,
				DAIamount,
				USDTamount,
				USDTamount.div(2),
				DAIamount.div(2),
				(await time.latest()) + 10,
			)

			const pairAddr = await UnoswapV2Controller_instance.pairFor(
				tokens.DAI.address,
				tokens.USDT.address,
			)

			const totalCostBeforeLiquidity = (
				await initialized_pool_instance.pool.getTotalCost()
			).toBigInt()

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				addLiquidityCalldata,
			)

			const pair_instance = await ethers.getContractAt(
				'@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair',
				pairAddr,
			)

			const balance = await pair_instance.balanceOf(initialized_pool_instance.pool.address)
			const precomputedLiquidity = _BNsqrt(USDTamount.mul(DAIamount)).toBigInt()

			// Uniswap floating rate is about 0.1% so we check that the balance is in range of 0.1% of precomputed liquidity
			expect(balance).to.lessThanOrEqual((precomputedLiquidity * 1001n) / 1000n)
			expect(balance).to.greaterThanOrEqual((precomputedLiquidity * 999n) / 1000n)

			const totalCostAfterLiquidity = await initialized_pool_instance.pool.getTotalCost()

			expect(totalCostAfterLiquidity).to.lessThanOrEqual((totalCostBeforeLiquidity * 1001n) / 1000n)
			expect(totalCostBeforeLiquidity).to.greaterThanOrEqual(
				(totalCostBeforeLiquidity * 999n) / 1000n,
			)
		})
		it('Should be able to remove liquidity from UniswapV2', async () => {
			const { tokens, initialized_pool_instance, UnoswapV2Controller_instance, bob, QuexCore_instance } =
				await loadFixture(fundWithPoolFixture)

			await depositAndSwap(
				initialized_pool_instance.pool,
				UnoswapV2Controller_instance,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(8),
				tokens.USDT,
				tokens.DAI,
				QuexCore_instance
			)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(2),
			)

			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(2))

			const [usdtDecimals, daiDecimals] = await Promise.all([
				tokens.USDT.decimals(),
				tokens.DAI.decimals(),
			])
			const USDTamount = constants.ONE_HUNDRED_BUCKS
			const DAIamount = convertDecimals(constants.ONE_HUNDRED_BUCKS, usdtDecimals, daiDecimals)
			const addLiquidityCalldata = encodePoolAddLiqudityDataAsIsUniswapV2(
				tokens.DAI.address,
				tokens.USDT.address,
				DAIamount,
				USDTamount,
				USDTamount.div(2),
				DAIamount.div(2),
				(await time.latest()) + 10,
			)

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				addLiquidityCalldata,
			)

			const pairAddr = await UnoswapV2Controller_instance.pairFor(
				tokens.DAI.address,
				tokens.USDT.address,
			)

			const pair_instance = await ethers.getContractAt(
				'@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair',
				pairAddr,
			)

			const balance = await pair_instance.balanceOf(initialized_pool_instance.pool.address)

			const rlCalldata = encodePoolRemoveLiquidityUniswapV2(
				tokens.DAI.address,
				tokens.USDT.address,
				balance,
				constants.ONE_HUNDRED_BUCKS.mul(98).div(100), // fees included, changed swap rate included
				constants.ONE_HUNDRED_BUCKS.mul(98).div(100), //
				(await time.latest()) + 10,
			)

			await expect(
				initialized_pool_instance.pool.protocolAction(
					constants.UFarm.prtocols.UniswapV2ProtocolString,
					rlCalldata,
				),
			).to.changeTokenBalance(pair_instance, initialized_pool_instance.pool, balance.mul(-1))
		})

		it('Should swap with long path', async () => {
			const { tokens, initialized_pool_instance, bob, QuexCore_instance } = await loadFixture(fundWithPoolFixture)

			await mintAndDeposit(
				initialized_pool_instance.pool,
				tokens.USDT,
				bob,
				constants.ONE_HUNDRED_BUCKS.mul(10),
			)
			await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, constants.ONE_HUNDRED_BUCKS.mul(10))

			const calldata = encodePoolSwapDataUniswapV2(
				constants.ONE_HUNDRED_BUCKS,
				constants.ONE_HUNDRED_BUCKS.div(2),
				BigNumber.from((await time.latest()) + 10),
				[tokens.USDT.address, tokens.DAI.address, tokens.USDC.address],
			)

			const USDCBalanceBefore = await tokens.USDC.balanceOf(initialized_pool_instance.pool.address)

			await initialized_pool_instance.pool.protocolAction(
				constants.UFarm.prtocols.UniswapV2ProtocolString,
				calldata,
			)

			const USDCBalanceAfter = await tokens.USDC.balanceOf(initialized_pool_instance.pool.address)

			expect(USDCBalanceAfter.sub(USDCBalanceBefore)).to.be.greaterThanOrEqual(
				constants.ONE_HUNDRED_BUCKS.div(2),
			)
		})
	})
	describe('Lido integration', () => {
		it('Should able to fetch wstETH/ETH', async () => {
			const {
				tokens,
				PriceOracle_instance,
				feedInstancesTokenToUSDT,
				MockedAggregator_wstETHstETH,
				increaseWstETHRate,
			} = await loadFixture(blankPoolWithRatesFixture)

			if (!feedInstancesTokenToUSDT.stETH) {
				console.log(`todo remove`)
				return
			}

			for (let i = 0; i < 3; i++) {
				await (
					MockedAggregator_wstETHstETH as MockV3wstETHstETHAgg
				).updateAnswerWithChainlinkPrice() // update with new price from LIDO

				const [chainlinkStETHprice, chainlinkWstETHprice, rateFromLido, rateFromChainlink] =
					await Promise.all([
						feedInstancesTokenToUSDT.stETH.latestAnswer(),
						feedInstancesTokenToUSDT.WstETH.latestAnswer(),
						tokens.WstETH.stEthPerToken(),
						MockedAggregator_wstETHstETH.latestAnswer(),
					])
				expect(rateFromChainlink).eq(rateFromLido, 'mocked aggregator is broken')

				expect(chainlinkWstETHprice).to.eq(
					chainlinkStETHprice.mul(rateFromChainlink).div(constants.ONE),
				)

				await increaseWstETHRate()
			}
		})
	}),
		describe('OneInchController', () => {
			describe('OneInch integration', () => {
				it('Should be able to swap tokens using OneInch, unoswapTo', async () => {
					const {
						initialized_pool_instance,
						tokens,
						oneInchAggrV5_instance,
						UnoswapV2Controller_instance,
						UFarmFund_instance,
						OneInchController_instance,
						QuexCore_instance
					} = await loadFixture(fundWithPoolFixture)

					const transferAmount = constants.ONE_HUNDRED_BUCKS.div(2)

					await UFarmFund_instance.depositToPool(
						initialized_pool_instance.pool.address,
						transferAmount,
					)
					await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, transferAmount)

					const injectedOneInchResponse = await oneInchCustomUnoswapTo(
						oneInchAggrV5_instance.address,
						transferAmount,
						0,
						initialized_pool_instance.pool.address,
						[tokens.USDT.address, tokens.WETH.address],
						UnoswapV2Controller_instance,
					)

					const wethBalanceBefore = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					const oneInchSwapTxData = encodePoolOneInchSwap(injectedOneInchResponse.tx.data)

					const beforeSwapSnapshot = await takeSnapshot()

					const swapEvent = await getEventFromTx(
						initialized_pool_instance.pool.protocolAction(
							constants.UFarm.prtocols.OneInchProtocolString,
							oneInchSwapTxData,
						),
						OneInchController_instance,
						'SwapOneInchV5',
					)

					const [tokenInAddr, tokenOutAddr, amountIn, amountOut] = [
						swapEvent.args.tokenIn as string,
						swapEvent.args.tokenOut as string,
						swapEvent.args.amountIn as BigNumber,
						swapEvent.args.amountOut as BigNumber,
					]

					const wethBalanceAfter = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					expect(injectedOneInchResponse.toAmount).to.be.greaterThan(0)

					expect(wethBalanceAfter.sub(wethBalanceBefore)).to.be.greaterThanOrEqual(
						injectedOneInchResponse.toAmount,
						'WETH balance should increase by amount of WETH received from swap',
					)

					await beforeSwapSnapshot.restore()

					await expect(
						initialized_pool_instance.pool.protocolAction(
							constants.UFarm.prtocols.OneInchProtocolString,
							oneInchSwapTxData,
						),
					)
						.to.changeTokenBalance(
							await ethers.getContractAt(
								'@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
								tokenInAddr,
							),
							initialized_pool_instance.pool,
							amountIn.mul(-1),
						)
						.to.changeTokenBalance(
							await ethers.getContractAt(
								'@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
								tokenOutAddr,
							),
							initialized_pool_instance.pool,
							amountOut,
						)
				})
				it('Should be able to swap tokens using OneInch, unoswap', async () => {
					const {
						initialized_pool_instance,
						tokens,
						oneInchAggrV5_instance,
						UnoswapV2Controller_instance,
						UFarmFund_instance,
						OneInchController_instance,
						QuexCore_instance
					} = await loadFixture(fundWithPoolFixture)

					const transferAmount = constants.ONE_HUNDRED_BUCKS.div(2)

					await UFarmFund_instance.depositToPool(
						initialized_pool_instance.pool.address,
						transferAmount,
					)
					await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, transferAmount)

					const injectedOneInchResponse = await oneInchCustomUnoswap(
						oneInchAggrV5_instance.address,
						transferAmount,
						0,
						initialized_pool_instance.pool.address,
						[tokens.USDT.address, tokens.WETH.address],
						UnoswapV2Controller_instance,
					)

					const wethBalanceBefore = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					const oneInchSwapTxData = encodePoolOneInchSwap(injectedOneInchResponse.tx.data)

					const beforeSwapSnapshot = await takeSnapshot()

					const swapEvent = await getEventFromTx(
						initialized_pool_instance.pool.protocolAction(
							constants.UFarm.prtocols.OneInchProtocolString,
							oneInchSwapTxData,
						),
						OneInchController_instance,
						'SwapOneInchV5',
					)

					const [tokenInAddr, tokenOutAddr, amountIn, amountOut] = [
						swapEvent.args.tokenIn as string,
						swapEvent.args.tokenOut as string,
						swapEvent.args.amountIn as BigNumber,
						swapEvent.args.amountOut as BigNumber,
					]

					const wethBalanceAfter = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					expect(injectedOneInchResponse.toAmount).to.be.greaterThan(0)

					expect(wethBalanceAfter.sub(wethBalanceBefore)).to.be.greaterThanOrEqual(
						injectedOneInchResponse.toAmount,
						'WETH balance should increase by amount of WETH received from swap',
					)

					await beforeSwapSnapshot.restore()

					await expect(
						initialized_pool_instance.pool.protocolAction(
							constants.UFarm.prtocols.OneInchProtocolString,
							oneInchSwapTxData,
						),
					)
						.to.changeTokenBalance(
							await ethers.getContractAt(
								'@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
								tokenInAddr,
							),
							initialized_pool_instance.pool,
							amountIn.mul(-1),
						)
						.to.changeTokenBalance(
							await ethers.getContractAt(
								'@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20',
								tokenOutAddr,
							),
							initialized_pool_instance.pool,
							amountOut,
						)
				})

				it('Should be able to swap tokens using OneInch, uniswapV3SwapTo', async () => {
					const {
						initialized_pool_instance,
						tokens,
						UFarmFund_instance,
						inchConverter_instance,
						uniswapV3Factory_instance,
						quoter_instance,
						QuexCore_instance
					} = await loadFixture(fundWithPoolFixture)

					const transferAmount = constants.ONE_HUNDRED_BUCKS.div(2)

					await UFarmFund_instance.depositToPool(
						initialized_pool_instance.pool.address,
						transferAmount,
					)
					await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, transferAmount)

					const swapData: OneInchToUfarmTestEnv.UniswapV3CustomDataStruct = {
						customRecipient: initialized_pool_instance.pool.address,
						customAmountIn: transferAmount,
						customRoute: uniV3_tokensFeesToPath([tokens.USDT.address, 3000, tokens.WETH.address]),
						factory: uniswapV3Factory_instance.address,
						positionManager: inchConverter_instance.address,
						quoter: quoter_instance.address,
						minReturn: 1, // at least something should be returned
						unwrapWethOut: false,
					}

					const injectedOneInchResponse =
						await inchConverter_instance.callStatic.toOneInchUniswapV3SwapTo(swapData)

					const wethBalanceBefore = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					const oneInchSwapTxData = encodePoolOneInchSwap(injectedOneInchResponse.customTxData.data)

					await initialized_pool_instance.pool.protocolAction(
						constants.UFarm.prtocols.OneInchProtocolString,
						oneInchSwapTxData,
					)

					const wethBalanceAfter = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					expect(injectedOneInchResponse.minReturn).to.be.greaterThan(0)

					expect(wethBalanceAfter.sub(wethBalanceBefore)).to.be.greaterThanOrEqual(
						injectedOneInchResponse.minReturn,
						'WETH balance should increase by amount of WETH received from swap',
					)
				})
				it('Should be able to swap tokens using OneInch, uniswapV3Swap', async () => {
					const {
						initialized_pool_instance,
						tokens,
						UFarmFund_instance,
						inchConverter_instance,
						uniswapV3Factory_instance,
						quoter_instance,
						QuexCore_instance
					} = await loadFixture(fundWithPoolFixture)

					const transferAmount = constants.ONE_HUNDRED_BUCKS.div(2)

					await UFarmFund_instance.depositToPool(
						initialized_pool_instance.pool.address,
						transferAmount,
					)
					await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, transferAmount)

					const swapData: OneInchToUfarmTestEnv.UniswapV3CustomDataStruct = {
						customRecipient: initialized_pool_instance.pool.address,
						customAmountIn: transferAmount,
						customRoute: uniV3_tokensFeesToPath([tokens.USDT.address, 3000, tokens.WETH.address]),
						factory: uniswapV3Factory_instance.address,
						positionManager: inchConverter_instance.address,
						quoter: quoter_instance.address,
						minReturn: 1, // at least something should be returned
						unwrapWethOut: false,
					}

					const injectedOneInchResponse =
						await inchConverter_instance.callStatic.toOneInchUniswapV3Swap(swapData)

					const wethBalanceBefore = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					const oneInchSwapTxData = encodePoolOneInchSwap(injectedOneInchResponse.customTxData.data)

					await initialized_pool_instance.pool.protocolAction(
						constants.UFarm.prtocols.OneInchProtocolString,
						oneInchSwapTxData,
					)

					const wethBalanceAfter = await tokens.WETH.balanceOf(
						initialized_pool_instance.pool.address,
					)

					expect(injectedOneInchResponse.minReturn).to.be.greaterThan(0)

					expect(wethBalanceAfter.sub(wethBalanceBefore)).to.be.greaterThanOrEqual(
						injectedOneInchResponse.minReturn,
						'WETH balance should increase by amount of WETH received from swap',
					)
				})
				it('Should be able to swap tokens using OneInchMultiSwap with UnoV3 and V2 swaps', async () => {
					const {
						initialized_pool_instance,
						tokens,
						UFarmFund_instance,
						inchConverter_instance,
						uniswapV3Factory_instance,
						quoter_instance,
						oneInchAggrV5_instance,
						UnoswapV2Controller_instance,
						QuexCore_instance
					} = await loadFixture(fundWithPoolFixture)

					const deployerSigner = await getDeployerSigner(hre)

					const usdtDeposit = constants.ONE_HUNDRED_BUCKS.mul(2)

					await mintTokens(tokens.USDT, usdtDeposit, deployerSigner)
					await tokens.USDT.connect(deployerSigner).transfer(
						UFarmFund_instance.address,
						usdtDeposit,
					)

					await UFarmFund_instance.depositToPool(
						initialized_pool_instance.pool.address,
						usdtDeposit,
					)
					await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, usdtDeposit)

					const quoteUSDTUSDC = await quoteMaxSlippageSingle(quoter_instance, {
						tokenIn: tokens.USDT.address,
						tokenOut: tokens.USDC.address,
						amountIn: usdtDeposit,
						fee: 3000,
						sqrtPriceLimitX96: 0,
					})

					const quoteUSDCDAI = await quoteMaxSlippageSingle(quoter_instance, {
						tokenIn: tokens.USDC.address,
						tokenOut: tokens.DAI.address,
						amountIn: quoteUSDTUSDC.amountOut,
						fee: 3000,
						sqrtPriceLimitX96: 0,
					})

					const swapDataV3: OneInchToUfarmTestEnv.UniswapV3CustomDataStruct = {
						customRecipient: initialized_pool_instance.pool.address,
						customAmountIn: usdtDeposit,
						customRoute: uniV3_tokensFeesToPath([
							tokens.USDT.address,
							3000,
							tokens.USDC.address,
							3000,
							tokens.DAI.address,
						]),
						factory: uniswapV3Factory_instance.address,
						positionManager: inchConverter_instance.address,
						quoter: quoter_instance.address,
						minReturn: quoteUSDCDAI.amountOut, // at least something should be returned
						unwrapWethOut: false,
					}

					const injectedOneInchResponseV3 =
						await inchConverter_instance.callStatic.toOneInchUniswapV3SwapTo(swapDataV3)

					const injectedOneInchResponseV2 = await oneInchCustomUnoswap(
						oneInchAggrV5_instance.address,
						quoteUSDCDAI.amountOut,
						0,
						initialized_pool_instance.pool.address,
						[tokens.DAI.address, tokens.WETH.address],
						UnoswapV2Controller_instance,
					)

					const quoteDAIWETH = await UnoswapV2Controller_instance.getAmountOut(
						quoteUSDCDAI.amountOut,
						[tokens.DAI.address, tokens.WETH.address],
					)

					const twoSwapsEncoded = encodePoolOneInchMultiSwap([
						injectedOneInchResponseV3.customTxData.data,
						injectedOneInchResponseV2.tx.data,
					])

					const poolAsOneInchController = OneInchV5Controller__factory.connect(
						initialized_pool_instance.pool.address,
						deployerSigner,
					)

					await expect(
						initialized_pool_instance.pool.protocolAction(
							constants.UFarm.prtocols.OneInchProtocolString,
							twoSwapsEncoded,
						),
					)
						.to.emit(poolAsOneInchController, 'SwapOneInchV5')
						.withArgs(
							tokens.USDT.address,
							tokens.WETH.address,
							usdtDeposit,
							quoteDAIWETH,
							constants.UFarm.prtocols.OneInchProtocolString,
						)
				})
			})
		})
	describe('UFarmPool -> ArbitraryController', function () {

		const PROTOCOL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ArbitraryController'))
		const DAPP = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('UniswapV2'))
		const depositAmount = constants.ONE_HUNDRED_BUCKS.mul(10)
		const arbitraryControllerIface = new ethers.utils.Interface([
			'function performAction(bytes32 dapp, address dappAddress, bytes calldata payload, uint256 value)'
		])
		const iface = new ethers.utils.Interface([
			"function swapExactTokensForTokens(uint,uint,address[],address,uint)",
			"function addLiquidity(address,address,uint,uint,uint,uint,address,uint)",
			"function removeLiquidity(address,address,uint,uint,uint,address,uint)",
			"function approve(address spender, uint256 amount)",
		])      
		const swapSig = iface.getSighash("swapExactTokensForTokens")
		const addLiquiditySig = iface.getSighash("addLiquidity")
		const removeLiquiditySig = iface.getSighash("removeLiquidity")
		const approveSig = iface.getSighash("approve")
	
		let deployer: any
		let Guard_instance: any
		let GuardWithSigner: any
	
		let tokens: any
		let initialized_pool_instance: any
		let UFarmCore_instance: any
		let QuexCore_instance: any
		let ufarmFund: string
		let dappAddress: string // 0x4A3D62E045FB824F08072FDfBB7A42C537778E3c - Local UniswapV2Router02
		
		before(async function () {

			[deployer] = await ethers.getSigners()
		
			const fixture = await loadFixture(fundWithPoolFixture)
			tokens = fixture.tokens
			initialized_pool_instance = fixture.initialized_pool_instance
			UFarmCore_instance = fixture.UFarmCore_instance
			QuexCore_instance = fixture.QuexCore_instance
			ufarmFund = await initialized_pool_instance.pool.ufarmFund()
			const {UniswapV2Router02_instance} = await loadFixture(ETHPoolFixture)
			dappAddress = UniswapV2Router02_instance.address
			const guardDeployment = await hre.deployments.get('Guard')
  			Guard_instance = await hre.ethers.getContractAt(guardDeployment.abi, guardDeployment.address)
			GuardWithSigner = Guard_instance.connect(deployer)
		
		})

		async function approveViaController(token: any, amount: any) {
			const tokenInterface = new ethers.utils.Interface([
			  "function approve(address spender, uint256 amount)"
			])
			const payload = tokenInterface.encodeFunctionData("approve", [dappAddress, amount])
			const ethValue = '0'
			const encoded = arbitraryControllerIface.encodeFunctionData('performAction', [
			  DAPP, token.address, payload, ethValue
			])
			await initialized_pool_instance.pool.protocolAction(PROTOCOL, encoded)
			const allowance = await token.allowance(initialized_pool_instance.pool.address, dappAddress)
			expect(allowance).to.equal(amount)
		}

		describe('ArbitraryController, controller usability tests, methods and dapps whitelisting tests', () => {

			it('Should allow enabling ArbitraryController in UFarmCore', async () => {
			  await UFarmCore_instance.connect(deployer).setAllowArbitraryController(ufarmFund, true)
			  const allowed = await UFarmCore_instance.isAllowedArbitraryController(ufarmFund)
			  expect(allowed).to.be.true
			})
		  
			it('Should allow disabling ArbitraryController in UFarmCore', async () => {
			  await UFarmCore_instance.connect(deployer).setAllowArbitraryController(ufarmFund, false)
			  const allowed = await UFarmCore_instance.isAllowedArbitraryController(ufarmFund)
			  expect(allowed).to.be.false
			})
		  
			it('Should revert when enabling useArbitraryController if core disallows it', async () => {
			  await UFarmCore_instance.connect(deployer).setAllowArbitraryController(ufarmFund, false)
			
			  await expect(
				initialized_pool_instance.pool.setUseArbitraryController(true)
			  ).to.be.revertedWithCustomError(
				initialized_pool_instance.pool,
				"NotAllowedToUseArbController"
			  ).withArgs(await initialized_pool_instance.pool.ufarmFund())
			})
		  
			it('Should not allow ArbitraryController use if not whitelisted in core', async () => {
			  await expect(
				initialized_pool_instance.pool.setUseArbitraryController(true)
			  ).to.be.revertedWithCustomError(
				initialized_pool_instance.pool,
				"NotAllowedToUseArbController"
			  ).withArgs(await initialized_pool_instance.pool.ufarmFund())
			})
			
			it('Should allow ArbitraryController only when both flags are enabled', async () => {
			  await UFarmCore_instance.connect(deployer).setAllowArbitraryController(ufarmFund, true)
			  await initialized_pool_instance.pool.setUseArbitraryController(true)
		  
			  const allowedFund = await UFarmCore_instance.isAllowedArbitraryController(ufarmFund)
			  const allowedPool = await initialized_pool_instance.pool.useArbitraryController()
			  expect(allowedFund).to.be.true
			  expect(allowedPool).to.be.true
		
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[tokens.USDT.address, tokens.USDC.address],
				[iface.getSighash("approve")]
			  )
		  
			  await expect( 
				approveViaController(tokens.USDT, 1000000)
			  ).to.not.be.reverted
			})
		
			//*
			it("Should return false for isProtocolAllowed before adding", async () => {
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				dappAddress,
				swapSig
			  )
			  expect(allowed).to.be.false
			})
		  
			it("Should allow added method on whitelisted dapp", async () => {
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[dappAddress],
				[swapSig]
			  )
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				dappAddress,
				swapSig
			  )
			  expect(allowed).to.be.true
			})
		  
			it("Should return false for other methods not added", async () => {
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[dappAddress],
				[swapSig]
			  )
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				dappAddress,
				addLiquiditySig
			  )
			  expect(allowed).to.be.false
			})
		  
			it("Should return false for same method on non-whitelisted address", async () => {
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[dappAddress],
				[swapSig]
			  )
			  const fakeDapp = ethers.Wallet.createRandom().address
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				fakeDapp,
				swapSig
			  )
			  expect(allowed).to.be.false
			})
		  
			it("Should allow approve method on whitelisted token", async () => {
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[tokens.USDT.address],
				[approveSig]
			  )
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				tokens.USDT.address,
				approveSig
			  )
			  expect(allowed).to.be.true
			})
		  
			it("Should return false for approve on non-whitelisted token", async () => {
			  const randomToken = ethers.Wallet.createRandom().address
			  const allowed = await Guard_instance.isProtocolAllowed(
				DAPP,
				randomToken,
				approveSig
			  )
			  expect(allowed).to.be.false
			})
		})
		
		describe('ArbitraryController SWAP', () => {
		
			it('Should be able to swap via ArbitraryController', async function () {
			  
			  await UFarmCore_instance.connect(deployer).setAllowArbitraryController(ufarmFund, true)
			  await initialized_pool_instance.pool.setUseArbitraryController(true)
		
			  // Whitelist protocols and methods
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[dappAddress],
				[
				  iface.getSighash("swapExactTokensForTokens"),
				  iface.getSighash("addLiquidity"),
				  iface.getSighash("removeLiquidity"),
				]
			  )
			  await GuardWithSigner.addAllowedMethods(
				DAPP,
				[tokens.USDT.address, tokens.USDC.address],
				[iface.getSighash("approve")]
			  )
		
			  // Setup initial deposit
			await tokens.USDT.mint(deployer.address, depositAmount.mul(100))
			await tokens.USDC.mint(deployer.address, depositAmount.mul(100))
			await tokens.USDT.connect(deployer).approve(dappAddress, depositAmount.mul(100))
			await tokens.USDC.connect(deployer).approve(dappAddress, depositAmount.mul(100))
			await mintAndDeposit(
			  initialized_pool_instance.pool,
			  tokens.USDT,
			  deployer,
			  depositAmount.mul(100)
			)
			await mintAndDeposit(
			  initialized_pool_instance.pool,
			  tokens.USDC,
			  deployer,
			  depositAmount.mul(100)
			)
			
			  // ADD LIQUIDITY BY DEPLOYER*********************************
			  const amountADesired = constants.ONE_HUNDRED_BUCKS.mul(10)
			  const amountBDesired = constants.ONE_HUNDRED_BUCKS.mul(10)
			  const amountAMin = amountADesired.div(2)
			  const amountBMin = amountBDesired.div(2)
			  const deadline = (await time.latest()) + 1000
		
			  const uniswapRouter = await ethers.getContractAt(
				'IUniswapV2Router02',
				dappAddress,
				deployer
			  )
			  const tx = await uniswapRouter
				.connect(deployer)
				.addLiquidity(
				  tokens.USDT.address,
				  tokens.USDC.address,
				  amountADesired,
				  amountBDesired,
				  amountAMin,
				  amountBMin,
				  deployer.address, 
				  deadline
				)
		
			  // APPROVE USDT, USDC******************
			  const approveAmount = constants.ONE_HUNDRED_BUCKS.mul(100)
			  await approveViaController(tokens.USDT, approveAmount)
			  await approveViaController(tokens.USDC, approveAmount)
		
			  // SWAP*********************************
			  await QuexCore_instance.sendResponse(initialized_pool_instance.pool.address, depositAmount)
			  const amountIn = constants.ONE_HUNDRED_BUCKS
			  const amountOutMin = constants.ONE_HUNDRED_BUCKS.div(2)
			  const path = [
				tokens.USDT.address,
				tokens.USDC.address,
			  ]
		
			  // Encode swap function
			  const swapInterface = new ethers.utils.Interface([
				"function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
			  ])
			  const swapPayload = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
				amountIn,
				amountOutMin,
				path,
				initialized_pool_instance.pool.address, 
				deadline,
			  ])
			  const ethValue = '0'
		
			  // Encode performAction call
			  const encodedPerformAction = arbitraryControllerIface.encodeFunctionData('performAction', [
				DAPP,
				dappAddress,
				swapPayload,
				ethValue,
			  ])
		
			  const USDTBalanceBefore = await tokens.USDT.balanceOf(initialized_pool_instance.pool.address)
			  const USDCBalanceBefore = await tokens.USDC.balanceOf(initialized_pool_instance.pool.address)
		
			  // Execute protocol action
			  await initialized_pool_instance.pool.protocolAction(
				PROTOCOL,
				encodedPerformAction
			  )            
		
			  const USDTBalanceAfter = await tokens.USDT.balanceOf(initialized_pool_instance.pool.address)
			  const USDCBalanceAfter = await tokens.USDC.balanceOf(initialized_pool_instance.pool.address)
		
			  expect(USDTBalanceAfter).to.equal(USDTBalanceBefore.sub(amountIn))
			  expect(USDCBalanceAfter.sub(USDCBalanceBefore)).to.be.gte(amountOutMin)
		
			})
		
		})
	})

})
