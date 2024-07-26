// SPDX-License-Identifier: UNLICENSED

import { task } from 'hardhat/config'
import { UFarmCore } from '../typechain-types'
import { types } from 'hardhat/config'

/**
 * Usage example:
 * npx hardhat grantUFarmPermissions --network arbitrumGoerli --permissions [0,1,2] --user 0xUser
 */
task('grantUFarmPermissions', 'Grant UFarm permission')
	.addParam('permissions', `list of permissions to grant '2,3'`, [2, 3], types.string)
	.addOptionalParam('user', 'user to grant permissions', '0xUser', types.string)
	.setAction(async function (
		{ permissions, user },
		{ ethers: { getContractAt, BigNumber, utils, provider }, deployments: { get } },
	) {
		const Core = (await getContractAt('UFarmCore', (await get('UFarmCore')).address)) as UFarmCore

		if (!utils.isAddress(user)) {
			if ((user as string) === '0xUser') {
				user = await provider.getSigner().getAddress()
				console.log(`Default user address was not set, user will be a caller with address: ${user}`)
			} else {
				throw new Error(`User (${user}) is not a proper EVM address.`)
			}
		}

		const permissionsToGrant: number[] = []

		const permissionList = JSON.parse(`[${permissions}]`) as number[];

		console.log(`Checking permissions ${permissionList} for ${user}`)


		for (const permission of permissionList) {
			const isPermissionGranted: boolean = await Core.hasPermission(user, permission)
			if (isPermissionGranted) {
				console.log(`Permission ${permission} is already granted to ${user}`)
			} else {
				permissionsToGrant.push(permission)
			}
		}

		if (permissionsToGrant.length !== 0) {
			console.log(`Granting permissions ${permissionsToGrant} to ${user}`)
			try {
				const tx = await Core.updatePermissions(user, permissionsToGrant)
				await tx.wait()
				console.log(`Permissions ${permissionsToGrant} granted to ${user}`)
			} catch (error) {
				throw new Error('Error granting permissions')
			}
		} else {
			console.log(`No permissions to grant`)
		}
	})
