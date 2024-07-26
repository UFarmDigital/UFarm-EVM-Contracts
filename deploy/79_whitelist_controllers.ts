// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import {
	_deployTags,
	getDeployerSigner,
	getInstanceFromDeployment,
	getNewContractName,
	retryOperation,
} from '../scripts/_deploy_helpers'
import { IController, UFarmCore } from '../typechain-types'

const whitelistControllers: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	const deployerSigner = await getDeployerSigner(hre)

	const uniV2Controller_deployment = await hre.deployments.get('UniV2Controller')
	const uniV3Controller_deployment = await hre.deployments.get('UniV3Controller')
	const oneInchController_deployment = await hre.deployments.get('OneInchV5Controller')

	const ufarmCore_deployment = await hre.deployments.get('UFarmCore')
	const ufarmCore_instance = getInstanceFromDeployment<UFarmCore>(hre, ufarmCore_deployment)

	console.log('\nWhitelisting controllers...')

	const controllersToWhitelist: Record<string, { address: string; controllerName: string }> = {}
	const controllersToUpdate: Record<string, { address: string; oldControllerName: string }> = {}

	const whitelistedProtocols = await ufarmCore_instance.getWhitelistedProtocols()

	for (const [controller, deployment] of Object.entries({
		UniV2Controller: uniV2Controller_deployment,
		UniV3Controller: uniV3Controller_deployment,
		OneInchV5Controller: oneInchController_deployment,
	})) {
		const controllerInstance = getInstanceFromDeployment<IController>(hre, deployment)
		const protocolName = await controllerInstance.PROTOCOL()

		if (!whitelistedProtocols.includes(protocolName)) {
			console.log(`Whitelisting ${controller} of protocol ${protocolName} ...`)
			controllersToWhitelist[protocolName] = {
				address: deployment.address,
				controllerName: controller,
			}
		} else {
			const newlyDeployedController = await hre.deployments.getOrNull(
				getNewContractName(controller),
			)
			if (newlyDeployedController) {
				console.log(
					`Updating controller ${controller} of protocol ${protocolName} to newly deployed ${newlyDeployedController.address} ...`,
				)
				controllersToUpdate[protocolName] = {
					address: newlyDeployedController.address,
					oldControllerName: controller,
				}
			} else
				console.log(
					`Controller ${controller} of protocol ${protocolName} already whitelisted, no need to update`,
				)
		}
	}

	if (Object.keys(controllersToWhitelist).length === 0) {
		console.log(`All controllers already whitelisted!`)
	} else {
		console.log(`Whitelisting controllers ...`)
		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'whitelistProtocolsWithControllers',

				Array.from(Object.keys(controllersToWhitelist)),
				Array.from(Object.values(controllersToWhitelist)).map((controller) => controller.address),
			)
		}, 3)
	}

	if (Object.keys(controllersToUpdate).length === 0) {
		console.log(`All controllers already updated!`)
	} else {
		console.log(`Updating controllers ...`)
		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'updateProtocolsControllers',

				Array.from(Object.keys(controllersToUpdate)),
				Array.from(Object.values(controllersToUpdate)).map((controller) => controller.address),
			)
		}, 3)

		// update new controller names
		for (const [protocolName, controller] of Object.entries(controllersToUpdate)) {
			const newControllerName = getNewContractName(controller.oldControllerName)
			const newControllerDeployment = await hre.deployments.get(newControllerName)
			await hre.deployments.delete(controller.oldControllerName)
			await hre.deployments.save(controller.oldControllerName, newControllerDeployment)
			await hre.deployments.delete(newControllerName)

			console.log(
				`Replaced controller deployment of ${controller.oldControllerName} for protocol ${protocolName} to newly deployed ${newControllerDeployment.address} ...`,
			)
		}

		console.log('Controllers updated!')
	}
}

export default whitelistControllers
whitelistControllers.dependencies = _deployTags([
	'InitializeUFarm',
	'UniV2Controller',
	'UniV3Controller',
	'OneInchV5Controller',
])
whitelistControllers.tags = _deployTags(['WhitelistControllers'])
