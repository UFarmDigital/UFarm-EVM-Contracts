// SPDX-License-Identifier: BUSL-1.1

import { ABI, DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	getDeployerSigner,
	getInstanceFromDeployment,
	retryOperation,
	getOrDeployPoolInstance,
	deployOrGetFund,
	activatePool,
	checkMinFundDep,
	_deployTags,
} from '../../../scripts/_deploy_helpers'
import {
	PoolCreationStruct,
	bitsToBigNumber,
	constants,
	packPerformanceCommission,
} from '../../../test/_helpers'
import { StableCoin, UFarmCore } from '../../../typechain-types'
import { ethers } from 'hardhat'
import { BigNumber } from '@ethersproject/bignumber'
import { _poolSwapUniV2 } from '../../../test/_fixtures'

const sepoliaEnvSetup: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!hre.network.tags['arbitrumSepolia']) {
		console.log('Not Arbitrum Sepolia network, skipping Sepolia environment setup')
		return
	}

	const { ufarmPanicManager, ufarmFundApprover, ufarmManager, fundOwner, ufarmOwner } =
		hre.namedAddresses

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

	const deplyerIsOwner = await ufarmCore_instance.hasPermissionsMask(
		deployerSigner.address,
		constants.ONE,
	)

	if (!deplyerIsOwner) {
		console.log(`Deployer is not owner, ending script`)
		return
	}

	const fund_instance = (
		await deployOrGetFund('TestFund', deployerSigner.address, ufarmCore_instance, hre)
	).connect(deployerSigner)

	const fundOwnerBalance = await hre.ethers.provider.getBalance(fundOwner)
	if (fundOwnerBalance.lt(constants.ONE.div(10))) {
		const diff = constants.ONE.div(10).sub(fundOwnerBalance)
		console.log(`Sending ${ethers.utils.formatEther(diff)} ETH to fund owner`)
		await deployerSigner.sendTransaction({
			to: fundOwner,
			value: diff,
		})
	}

	const initialFundStatus = await fund_instance.status()
	if (initialFundStatus < constants.Fund.State.Active) {
		console.log(`Current fund status is ${initialFundStatus}, setting to Active`)
		await fund_instance.changeStatus(constants.Fund.State.Active)
	} else {
		console.log(`Current fund status is ${initialFundStatus}`)
	}

	const emptyPoolArgs: PoolCreationStruct = {
		minInvestment: 0,
		maxInvestment: hre.ethers.constants.MaxUint256,
		managementCommission: 0,
		packedPerformanceCommission: 0,
		withdrawalLockupPeriod: 0,
		valueToken: usdt_deployment.address,
		staff: [],
		name: 'Initialized Pool',
		symbol: 'IP-1',
	}

	const pool_instance_1 = await getOrDeployPoolInstance(
		'TestPool',
		{
			...emptyPoolArgs,
			staff: [],
		},
		fund_instance,
		hre,
	)

	// Activate pool
	await retryOperation(async () => {
		await activatePool(pool_instance_1, usdt_instance, deployerSigner, hre)
	}, 3)

	const anotherPool_instance = await getOrDeployPoolInstance(
		'TestPool2',
		{
			...emptyPoolArgs,
			minInvestment: constants.ONE_HUNDRED_BUCKS.mul(5),
			maxInvestment: constants.ONE_HUNDRED_BUCKS.mul(100),
			managementCommission: constants.FIVE_PERCENTS,
			packedPerformanceCommission: packPerformanceCommission([
				{ step: 0, commission: constants.Pool.Commission.MAX_PERFORMANCE_COMMISION / 100 },
			]),
		},
		fund_instance,
		hre,
	)

	const simplePool_instance = await getOrDeployPoolInstance(
		'TestPool3',
		{
			...emptyPoolArgs,
			name: 'Simple Pool',
			symbol: 'SP',
			staff: [],
		},
		fund_instance,
		hre,
	)

	await retryOperation(async () => {
		await activatePool(anotherPool_instance, usdt_instance, deployerSigner, hre)
	}, 3)

	// mint to fund
	const desiredBalance = constants.ONE_HUNDRED_BUCKS.mul(77777777777777)
	const deployer_USDT_balance = await usdt_instance.balanceOf(deployerSigner.address)
	const difference = desiredBalance.gt(deployer_USDT_balance)
		? desiredBalance.sub(deployer_USDT_balance)
		: BigNumber.from(0)
	if (difference.gt(BigNumber.from(0))) {
		await (await usdt_instance.mint(deployerSigner.address, difference)).wait()
	}

	await checkMinFundDep(ufarmCore_instance.connect(deployerSigner), constants.ONE_BUCKS.mul(100))

	// set protocol fee
	const currentProtocolCommission = await ufarmCore_instance.protocolCommission()
	if (!currentProtocolCommission.eq(constants.ZERO_POINT_3_PERCENTS)) {
		console.log(`Current protocol commission is ${currentProtocolCommission}, setting to 0.3%`)
		await ufarmCore_instance.setProtocolCommission(constants.ZERO_POINT_3_PERCENTS)
		console.log(`Protocol commission set to 0.3%`)
	} else {
		console.log(`Current protocol commission is ${currentProtocolCommission}`)
	}

	// grant UFarm permissions
	{
		const ufarmPermissions = constants.UFarm.Permissions
		const ufarmRoles = constants.UFarm.Roles

		if (ufarmPanicManager !== '') {
			const mask = bitsToBigNumber(ufarmRoles.MemberRole.concat(ufarmPermissions.TurnPauseOn))
			const currentPermissions = await ufarmCore_instance.hasPermissionsMask(
				ufarmPanicManager,
				mask,
			)
			await retryOperation(async () => {
				if (!currentPermissions) {
					await hre.deployments.execute(
						'UFarmCore',
						{ from: deployerSigner.address },
						'updatePermissions',
						ufarmPanicManager,
						bitsToBigNumber(ufarmRoles.MemberRole.concat(ufarmPermissions.TurnPauseOn)),
					)
					console.log(`Panic manager permissions set for ${ufarmPanicManager}`)
				} else {
					console.log(`Panic manager permissions already set`)
				}
			}, 3)
		}

		if (ufarmFundApprover !== '') {
			const mask = bitsToBigNumber(
				ufarmRoles.MemberRole.concat(Object.values(ufarmRoles.ModeratorRole)),
			)
			const currentPermissions = await ufarmCore_instance.hasPermissionsMask(
				ufarmFundApprover,
				mask,
			)
			if (!currentPermissions) {
				await retryOperation(async () => {
					await hre.deployments.execute(
						'UFarmCore',
						{ from: deployerSigner.address },
						'updatePermissions',
						ufarmFundApprover,
						mask,
					)
				}, 3)
				console.log(`Fund approver permissions set`)
			}
		}

		if (ufarmManager !== '') {
			const mask = bitsToBigNumber(
				ufarmRoles.MemberRole.concat(...ufarmRoles.TeamManagerRole, ...ufarmRoles.ModeratorRole),
			)
			const currentPermissions = await ufarmCore_instance.hasPermissionsMask(ufarmManager, mask)
			if (!currentPermissions) {
				await retryOperation(async () => {
					await hre.deployments.execute(
						'UFarmCore',
						{ from: deployerSigner.address },
						'updatePermissions',
						ufarmManager,
						mask,
					)
				}, 3)
				console.log(`Manager permissions set`)
			}
		}

		if (ufarmOwner !== '') {
			const ownerMask = hre.ethers.constants.MaxUint256
			const currentPermissions = await ufarmCore_instance.hasPermissionsMask(ufarmOwner, ownerMask)
			if (!currentPermissions) {
				await retryOperation(async () => {
					await hre.deployments.execute(
						'UFarmCore',
						{ from: deployerSigner.address },
						'updatePermissions',
						ufarmOwner,
						ownerMask,
					)
				}, 3)
				console.log(`Owner permissions set`)
			}
		}
	}

	{
		console.log('Topup demo balances')

		const demoTopups = [
			{
				address: ufarmFundApprover,
				usdt: constants.ONE_BUCKS.mul(100_000_000),
				eth: constants.ONE.mul(5),
			},
			{
				address: ufarmManager,
				usdt: constants.ONE_BUCKS.mul(1_000_000),
				eth: constants.ONE.div(10),
			},
		]

		for (const topup of demoTopups) {
			if (topup.address === '') {
				continue
			}

			const addr = topup.address
			const addrUSDTBalance = await usdt_instance.balanceOf(addr)
			const addrETHBalance = await hre.ethers.provider.getBalance(addr)

			const desiredUsdtBalance = topup.usdt
			const desiredEthBalance = topup.eth

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

	console.log(`Deployer: ${deployerSigner.address}`)
	console.log(
		`Deployers final balance: ${ethers.utils.formatEther(await deployerSigner.getBalance())} ETH`,
	)

	console.log(`\n\nDone!`)
}

export default sepoliaEnvSetup
sepoliaEnvSetup.dependencies = _deployTags([
	'Multicall3',
	'UniV2Pairs',
	'UniV3Pairs',
	'InitializeUFarm',
	'WhitelistControllers',
	'WhiteListTokens',
])
sepoliaEnvSetup.tags = _deployTags(['SepoliaEnv'])
