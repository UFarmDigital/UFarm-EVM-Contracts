// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	isTestnet,
	getDeployerSigner,
	getInstanceFromDeployment,
	retryOperation,
	checkMinFundDep,
	_deployTags,
} from '../../../scripts/_deploy_helpers'
import {
	constants,
	bitsToBigNumber,
} from '../../../test/_helpers'
import { UFarmCore } from '../../../typechain-types'

const deployUFarm: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (isTestnet(hre.network)) {
		console.log('Skipping UFarm deployment on testnet')
		return
	}

	const { ufarmPanicManager, ufarmFundApprover, ufarmManager, fundOwner, ufarmOwner } =
		hre.namedAddresses

	for (const [name, value] of Object.entries([
		ufarmPanicManager,
		ufarmFundApprover,
		ufarmManager,
		fundOwner,
		ufarmOwner,
	])) {
		if (!hre.ethers.utils.isAddress(value) || value === hre.ethers.constants.AddressZero) {
			console.log(`Address of ${name} is not set. Skipping...`)
		}
	}

	const deployerSigner = await getDeployerSigner(hre)

	const ufarmCore_deployment = await hre.deployments.get('UFarmCore')

	const ufarmCore_instance = getInstanceFromDeployment<UFarmCore>(
		hre,
		ufarmCore_deployment,
		deployerSigner,
	)
	const deplyerIsOwner = await ufarmCore_instance.hasPermissionsMask(
		deployerSigner.address,
		constants.UFarm.Permissions.Owner,
	)

	if (!deplyerIsOwner) {
		console.log(`Deployer is not owner, ending script`)
		return
	}
	const minFundDep = await ufarmCore_instance.connect(deployerSigner).minimumFundDeposit()
	if (minFundDep.isZero()){
		await checkMinFundDep(ufarmCore_instance.connect(deployerSigner), constants.ONE_BUCKS.mul(1000))
	}

	// set protocol fee
	const currentProtocolCommission = await ufarmCore_instance.protocolCommission()
	if (!currentProtocolCommission || currentProtocolCommission.isZero()) {
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
				ufarmRoles.MemberRole.concat(
					Object.values(ufarmRoles.BackendRole),
					Object.values(ufarmRoles.CrisisManagerRole),
				),
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
				ufarmRoles.MemberRole.concat(...ufarmRoles.ModeratorRole),
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

	// set delay after pool actions
	const currentDelay = await ufarmCore_instance.connect(deployerSigner).postActionDelay()
	if (!currentDelay || currentDelay.isZero()){
		console.log(`Current action delay is ${currentDelay}, setting to 5 min`)
		await ufarmCore_instance.setPostActionDelay(constants.Date.FIVE_MIN)
	} else {
		console.log(`Current action delay is ${currentDelay}`)
	}

	console.log(`Deployer: ${deployerSigner.address}`)
	console.log(
		`Deployers final balance: ${hre.ethers.utils.formatEther(
			await deployerSigner.getBalance(),
		)} ETH`,
	)

	console.log(`\n\nDone!`)
}
deployUFarm.dependencies = [
	'PrepareEnvARB',
	'InitializeUFarm',
	'WhitelistControllers',
	'WhiteListTokens',
]
deployUFarm.tags = _deployTags(['ProductionENV'])
export default deployUFarm
