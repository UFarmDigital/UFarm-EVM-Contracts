// SPDX-License-Identifier: BUSL-1.1

import { ABI, DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	getInstanceFromDeployment,
	customSetTimeout,
	retryOperation,
	getOrDeployPoolInstance,
	deployOrGetFund,
	activatePool,
	checkMinFundDep,
	updateFundPermissionsIfNotYet,
	_deployTags,
} from '../scripts/_deploy_helpers'
import {
	PoolCreationStruct,
	bigNumberToBits,
	bitsToBigNumber,
	constants,
	getFieldsByValue,
	mintAndDeposit,
	packPerformanceCommission,
	prepareWithdrawRequest,
} from '../test/_helpers'
import {
	StableCoin,
	UFarmCore,
	UnoswapV2Controller,
	WETH9,
} from '../typechain-types'
import { ethers } from 'hardhat'
import { BigNumberish, BigNumber } from '@ethersproject/bignumber'
import { _poolSwapUniV2 } from '../test/_fixtures'

const testEnvSetup: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (hre.network.tags['public'] || !isTestnet(hre.network)) {
		return
	}

	const deployerSigner = await getDeployerSigner(hre)
	const usdt_deployment = await hre.deployments.get('USDT')
	const ufarmCore_deployment = await hre.deployments.get('UFarmCore')

	const ufarmCore_instance = await getInstanceFromDeployment<UFarmCore>(
		hre,
		ufarmCore_deployment,
		deployerSigner,
	)
	const usdt_instance = await getInstanceFromDeployment<StableCoin>(
		hre,
		usdt_deployment,
		deployerSigner,
	)

	const namedSigners = await hre.getNamedAccounts()

	const fund_instance = (
		await deployOrGetFund('TestFund', deployerSigner.address, ufarmCore_instance, hre)
	).connect(deployerSigner)

	const fundStatus = await fund_instance.status()
	if (fundStatus !== constants.Fund.State.Active) {
		await (await fund_instance.changeStatus(constants.Fund.State.Active)).wait()
		console.log(`Fund status changed to active`)
	} else {
		console.log(`Fund status is already active`)
	}

	const emptyPoolArgs: PoolCreationStruct = {
		minInvestment: 0,
		maxInvestment: hre.ethers.constants.MaxUint256,
		managementCommission: 0,
		packedPerformanceCommission: packPerformanceCommission([
			{ step: 0, commission: constants.Pool.Commission.MAX_PERFORMANCE_COMMISION / 10 },
		]),
		withdrawalLockupPeriod: 0,
		valueToken: usdt_deployment.address,
		staff: [],
		name: 'Initialized Pool',
		symbol: 'IP-1',
	}

	async function updateUFarmPermissions(
		coreWithSigner: UFarmCore,
		address: string,
		permissions: BigNumberish,
	) {
		;(await coreWithSigner.updatePermissions(address, permissions)).wait()

		const permissionsString = getFieldsByValue(
			constants.UFarm.Permissions,
			bigNumberToBits(BigNumber.from(permissions)),
		).join(', ')

		console.log(
			`` + `Addr: [${address}]\n UFarmCore Permissions: [${permissionsString}]\n-----------------`,
		)
	}

	const carolInStaff = [
		{
			addr: namedSigners.carol,
			permissionsMask: bitsToBigNumber([
				constants.Pool.Permissions.Member,
				constants.Pool.Permissions.ApprovePoolTopup,
				constants.Pool.Permissions.PoolStatusControl,
				constants.Pool.Permissions.ManagePoolFunds,
				constants.Pool.Permissions.UpdatePoolDescription,
				constants.Pool.Permissions.UpdatePoolFees,
				constants.Pool.Permissions.UpdatePoolTopUpAmount,
				constants.Pool.Permissions.UpdatePoolPermissions,
			]),
		},
	]

	const pool_instance_1 = await getOrDeployPoolInstance(
		'TestPool',
		{
			...emptyPoolArgs,
			staff: [...carolInStaff],
		},
		fund_instance,
		hre,
	)

	await checkMinFundDep(ufarmCore_instance.connect(deployerSigner), BigNumber.from(0))

	await activatePool(pool_instance_1, usdt_instance, deployerSigner, hre)

	const sharesRequired = constants.ONE_BUCKS.mul(1337)
	const deployerShares = await pool_instance_1.pool.balanceOf(deployerSigner.address)
	if (deployerShares.lt(sharesRequired)) {
		const sharesToMint = sharesRequired.sub(deployerShares)
		console.log(
			`Minting ${ethers.utils.formatUnits(
				sharesRequired.sub(deployerShares),
				6,
			)} shares to deployer`,
		)
		// Deposit to the pool
		await mintAndDeposit(pool_instance_1.pool, usdt_instance, deployerSigner, sharesToMint)
	}

	{
		await customSetTimeout(1)

		console.log(`\nSetting up permissions for pool 1:`)
		console.log(`\nOwner [${deployerSigner.address}] permissions: \n - All`)

		const aliceMask = bitsToBigNumber(
			constants.Fund.Roles.MemberRole.concat(Object.values(constants.Fund.Roles.FundEditorRole)),
		)
		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.alice, aliceMask)

		const bobMask = bitsToBigNumber(
			constants.Fund.Roles.MemberRole.concat(
				Object.values(constants.Fund.Roles.PoolCreatorAndEditorRole),
			),
		)
		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.bob, bobMask)

		const carolMask = ethers.constants.MaxUint256
		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.carol, carolMask)

		const creatorFinanceManagerMask = bitsToBigNumber(
			constants.Fund.Roles.MemberRole.concat(
				Object.values(constants.Fund.Roles.PoolCreatorAndEditorRole),
				Object.values(constants.Fund.Roles.AllPoolsFinanceManagerRole),
			),
		)
		await updateFundPermissionsIfNotYet(
			fund_instance,
			namedSigners.david,
			creatorFinanceManagerMask,
		)
		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.emma, creatorFinanceManagerMask)

		const frankMask = bitsToBigNumber(
			constants.Fund.Roles.MemberRole.concat(
				Object.values(constants.Fund.Roles.PoolCreatorAndEditorRole),
			),
		)
		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.frank, frankMask)

		await updateFundPermissionsIfNotYet(
			fund_instance,
			namedSigners.grace,
			bitsToBigNumber(constants.Fund.Roles.MemberRole),
		)

		const henryMask = bitsToBigNumber(
			constants.Fund.Roles.MemberRole.concat(
				Object.values(constants.Fund.Roles.FundEditorRole),
				Object.values(constants.Fund.Roles.FundFinanceManagerRole),
			),
		)

		await updateFundPermissionsIfNotYet(fund_instance, namedSigners.henry, henryMask)
	}
	// Swap UNIv2
	{
		const uniswapV2Controller_deployment = await hre.deployments.get('UniV2Controller')
		const uniswapV2Controller_instance = await getInstanceFromDeployment<UnoswapV2Controller>(
			hre,
			uniswapV2Controller_deployment,
		)

		const weth_instance = await getInstanceFromDeployment<WETH9>(
			hre,
			await hre.deployments.get('WETH'),
		)

		const usdtPoolBalance = await usdt_instance.balanceOf(pool_instance_1.pool.address)
		const wethPoolBalance = await weth_instance.balanceOf(pool_instance_1.pool.address)

		if (usdtPoolBalance.gt(constants.ONE_HUNDRED_BUCKS) && wethPoolBalance.isZero()) {
			await retryOperation(async () => {
				const swap1usdt = await _poolSwapUniV2(
					pool_instance_1.pool,
					uniswapV2Controller_instance,
					constants.ONE_BUCKS,
					[usdt_instance.address, weth_instance.address],
				)
				await (await swap1usdt.tx).wait()
			}, 3)
		}

		console.log(
			`Weth balance in pool 1: ${await weth_instance.balanceOf(pool_instance_1.pool.address)}`,
		)
	}

	const anotherPool_instance = await getOrDeployPoolInstance(
		'TestPool2',
		{
			...emptyPoolArgs,
			minInvestment: constants.ONE_HUNDRED_BUCKS.mul(5),
			maxInvestment: constants.ONE_HUNDRED_BUCKS.mul(100),
		},
		fund_instance,
		hre,
	)

	const simplePool_staff = [
		{
			addr: namedSigners.carol,
			permissionsMask: bitsToBigNumber([
				constants.Pool.Permissions.Member,
				constants.Pool.Permissions.ApprovePoolTopup,
				constants.Pool.Permissions.PoolStatusControl,
				constants.Pool.Permissions.ManagePoolFunds,
				constants.Pool.Permissions.UpdatePoolDescription,
				constants.Pool.Permissions.UpdatePoolFees,
				constants.Pool.Permissions.UpdatePoolTopUpAmount,
				constants.Pool.Permissions.UpdatePoolPermissions,
			]),
		},
		{
			addr: namedSigners.henry,
			permissionsMask: bitsToBigNumber([
				constants.Pool.Permissions.Member,
				constants.Pool.Permissions.UpdatePoolDescription,
				constants.Pool.Permissions.UpdatePoolFees,
				constants.Pool.Permissions.UpdatePoolTopUpAmount,
				constants.Pool.Permissions.UpdatePoolPermissions,
			]),
		},
	]

	const poolTest3_instance = await getOrDeployPoolInstance(
		'TestPool3',
		{
			...emptyPoolArgs,
			name: 'Simple Pool',
			symbol: 'SP',
			staff: simplePool_staff,
		},
		fund_instance,
		hre,
	)

	await activatePool(poolTest3_instance, usdt_instance, deployerSigner, hre)

	{
		// mint random USDT amount to every named signer
		const first8signers = Object.entries(namedSigners).slice(0, 8)
		for (const [name, address] of first8signers) {
			const usdtToMint = constants.ONE_HUNDRED_BUCKS.mul(10).mul(
				BigNumber.from(
					// random:
					Math.floor(Math.random() * 100) + 1,
				),
			)

			const signer = await hre.ethers.getSigner(address)
			const signerShares = await poolTest3_instance.pool.balanceOf(address)
			if (signerShares.isZero()) {
				const usdToDeposit = usdtToMint.div(3)

				await (
					await mintAndDeposit(poolTest3_instance.pool, usdt_instance, signer, usdToDeposit)
				).wait()

				console.log(
					`Minted:${ethers.utils.formatUnits(
						usdtToMint,
						6,
					)} to ${name} and deposited ${ethers.utils.formatUnits(usdToDeposit, 6)} to pool 3`,
				)
			} else {
				console.log(`Skipping ${name} as they already have shares in pool 3`)
				continue
			}

			// Withdraw

			const withdrawAmount = (await poolTest3_instance.pool.balanceOf(signer.address)).div(2)

			await retryOperation(async () => {
				const withdrawalRequest = await prepareWithdrawRequest(
					signer,
					poolTest3_instance.pool,
					withdrawAmount,
				)

				// await (await poolTest3_instance.pool.connect(signer).withdraw(withdrawalRequest)).wait()
				await hre.deployments.execute(
					'TestPool3',
					{ from: signer.address, estimateGasExtra: 1000000 },
					'withdraw',
					withdrawalRequest,
				)

				console.log(
					`Withdrew ${ethers.utils.formatUnits(withdrawAmount, 6)} from pool 3 to ${name}`,
				)

				await customSetTimeout(1)
			}, 3)
		}

		// mint to fund

		await (
			await usdt_instance.mint(fund_instance.address, constants.ONE_HUNDRED_BUCKS.mul(77777))
		).wait()
	}
	// ;(await ufarmCore_instance.setMinimumFundDeposit(constants.ONE_HUNDRED_BUCKS.mul(10))).wait()

	await checkMinFundDep(ufarmCore_instance.connect(deployerSigner), constants.ONE_BUCKS.mul(10))
	{
		// Give UFarmCore permissions
		console.log('\n\n UFarmCore permissions: \n')
		const updateCorePermissionsIfNotYet = async (
			core: UFarmCore,
			coreMember: string,
			permissions: BigNumberish,
		) => {
			const hasPermissions = await core.hasPermissionsMask(coreMember, permissions)
			if (!hasPermissions) {
				await retryOperation(async () => {
					await updateUFarmPermissions(core, coreMember, permissions)
				}, 3)
				console.log(`\n${coreMember} permissions updated`)
			} else {
				console.log(`\n${coreMember} already has permissions in UFarmCore`)
			}
		}

		const permissionsUpdaterMask = bitsToBigNumber([
			constants.UFarm.Permissions.Member,
			constants.UFarm.Permissions.UpdatePermissions,
			constants.UFarm.Permissions.UpdateUFarmMember,
			constants.UFarm.Permissions.DeleteUFarmMember,
		])

		await updateCorePermissionsIfNotYet(
			ufarmCore_instance,
			namedSigners.alice,
			permissionsUpdaterMask,
		)

		const whitelistAndFundApproverMask = bitsToBigNumber([
			constants.UFarm.Permissions.Member,
			constants.UFarm.Permissions.ManageWhitelist,
			constants.UFarm.Permissions.ApproveFundCreation,
			constants.UFarm.Permissions.BlockFund,
		])

		await updateCorePermissionsIfNotYet(
			ufarmCore_instance,
			namedSigners.bob,
			whitelistAndFundApproverMask,
		)
		await updateCorePermissionsIfNotYet(
			ufarmCore_instance,
			namedSigners.carol,
			whitelistAndFundApproverMask,
		)

		const moderatorRoleMask = bitsToBigNumber(
			constants.UFarm.Roles.MemberRole.concat(Object.values(constants.UFarm.Roles.ModeratorRole)),
		)

		await updateCorePermissionsIfNotYet(ufarmCore_instance, namedSigners.david, moderatorRoleMask)
		await updateCorePermissionsIfNotYet(ufarmCore_instance, namedSigners.emma, moderatorRoleMask)

		const teamAndCrisisManagerMask = bitsToBigNumber(
			constants.UFarm.Roles.MemberRole.concat(
				Object.values(constants.UFarm.Roles.TeamManagerRole),
				Object.values(constants.UFarm.Roles.CrisisManagerRole),
			),
		)

		await updateCorePermissionsIfNotYet(
			ufarmCore_instance,
			namedSigners.frank,
			teamAndCrisisManagerMask,
		)
	}

	{
		console.log('Topup demo balances')

		const demoAddresses = [
			'0x5B16aBc8268f0fa6B111F45e20003f227389967C',
			'0x2cD031Cb7e075Ad30aCB2f7B8acc2A7d372EaFd5',
			namedSigners.carol,
		]

		for (const addr of demoAddresses) {
			const addrUSDTBalance = await usdt_instance.balanceOf(addr)
			const addrETHBalance = await hre.ethers.provider.getBalance(addr)

			const desiredUsdtBalance = constants.ONE.mul(88888888888)
			const desiredEthBalance = constants.ONE.mul(100)

			if (addrUSDTBalance.lt(desiredUsdtBalance)) {
				await (await usdt_instance.mint(addr, desiredUsdtBalance.sub(addrUSDTBalance))).wait()
				console.log(`Sent some USDT to ${addr}`)
			}
			if (addrETHBalance.lt(desiredEthBalance)) {
				await deployerSigner.sendTransaction({
					to: addr,
					value: desiredEthBalance.sub(addrETHBalance),
				})
				console.log(`Sent some ETH to ${addr}`)
			}
		}
	}

	// set protocol fee
	const currentProtocolCommission = await ufarmCore_instance.protocolCommission()
	if (!currentProtocolCommission.eq(constants.ZERO_POINT_3_PERCENTS)) {
		console.log(`Current protocol commission is ${currentProtocolCommission}, setting to 0.3%`)
		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{ from: deployerSigner.address },
				'setProtocolCommission',
				constants.ZERO_POINT_3_PERCENTS,
			)
		}, 3)
	} else {
		console.log(`Protocol commission set to 0.3%`)
	}

	console.log(`\n\nDone!`)
}

export default testEnvSetup
testEnvSetup.dependencies = _deployTags([
	'Multicall3',
	'UniV2Pairs',
	'UniV3Pairs',
	'InitializeUFarm',
	'WhitelistControllers',
	'WhiteListTokens',
])
testEnvSetup.tags = _deployTags(['TestEnv'])
