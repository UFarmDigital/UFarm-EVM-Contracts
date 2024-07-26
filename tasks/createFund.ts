// SPDX-License-Identifier: UNLICENSED

import { task } from 'hardhat/config'
import { UFarmCore } from '../typechain-types'
import { types } from 'hardhat/config'

task('createFund', 'Create a new Fund')
	.addParam('name', 'name of the fund', 'Fund Name', types.string)
	.addParam('appid', 'appid', '09fe49b3-4d2b-471c-ac04-36c9e706b85f', types.string)
	.addOptionalParam(
		'manager',
		'manager of the fund with full permissions',
		'0xManager',
		types.string,
	)
	.setAction(async function (
		{ name, manager, appid },
		{ ethers: { getContractAt, BigNumber, utils, provider }, deployments: { get } },
	) {
		const Core = (await getContractAt('UFarmCore', (await get('UFarmCore')).address)) as UFarmCore

		if (!utils.isAddress(manager)) {
			if ((manager as string) === '0xManager') {
				manager = await provider.getSigner().getAddress()
				console.log(
					`Default manager address was not set, manager will be a caller with address: ${manager}`,
				)
			} else {
				throw new Error(`Manager (${manager}) is not a proper EVM address.`)
			}
		}

		const tx = await Core.createFund(
			manager as string,
			utils.keccak256(utils.toUtf8Bytes(appid as string)),
		)
		const receipt = await tx.wait()

		const event = receipt.events?.find((e) => e.event === 'FundCreated')

		if (event) {
			console.log(`Fund '${event.args?.name}' created with address '${event.args?.fund}'`)
		}
	})
