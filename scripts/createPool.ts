// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { BigNumberish } from 'ethers'
import { UFarmPool, StableCoin, UFarmFund } from '../typechain-types'
import {
	PoolCreationStruct,
	getEventFromTx,
} from '../test/_helpers'

async function main() {
	const {
        fund,
        usdt,
	} = {
        fund: '0x8D30D3D813694415d4e44B1604F24a53236b6726',
        usdt: '0xd71fe004d84b10FbD161838F87A94f2327A315a1',
	}
	const poolArgs: PoolCreationStruct = {
		minInvestment: 1 as BigNumberish,
		maxInvestment: hre.ethers.utils.parseUnits('1000000', 6),
		managementCommission: 200 as BigNumberish,
		performanceCommission: 3000 as BigNumberish,
		depositLockupPeriod: 0 as BigNumberish, // will be removed
		withdrawalLockupPeriod: 0 as BigNumberish,
		valueToken: usdt,
		staff: [
            // Example staff member:
			// {
			// 	addr: bob.address,
			// 	permissionsMask: bitsToBigNumber([
			// 		constants.Pool.Permissions.Member,
			// 		constants.Pool.Permissions.UpdateLockupPeriods,
			// 	]),
			// },
			// {
			// 	addr: alice.address,
			// 	permissionsMask: bitsToBigNumber(Array.from(Object.values(constants.Pool.Permissions))),
			// },
		],
		name: 'UFarmPool',
		symbol: 'Pool symbol',
	}

    const fund_instance = (await hre.ethers.getContractAt('UFarmFund', fund)) as UFarmFund

    const event = await getEventFromTx(fund_instance.createPool(poolArgs),fund_instance,'PoolCreated')

    if (!event) {
        throw new Error('Pool creation failed')
    }

    console.log('Pool created at', event.args.pool)

}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})
