// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { BigNumberish } from 'ethers'
import { UFarmPool, StableCoin, UFarmFund, PoolAdmin, UFarmCore } from '../typechain-types'
import { PoolCreationStruct, constants, getEventFromTx } from '../test/_helpers'

async function main() {
	const { pool } = {
		pool: '0x2240ce642A77f4B7ea926035181DEC1f4e968AA4',
	}

	const pool_instance = (await hre.ethers.getContractAt('UFarmPool', pool)) as UFarmPool
	const pool_admin = await pool_instance.poolAdmin()
	console.log('Pool admin contract:', pool_admin)

    const pool_admin_instance = (await hre.ethers.getContractAt('PoolAdmin', pool_admin)) as PoolAdmin

    const core = await pool_instance.ufarmCore()
    const core_instance = (await hre.ethers.getContractAt('UFarmCore', core)) as UFarmCore
    const minFundDeposit = await core_instance.minimumFundDeposit()

    const fund = await pool_instance.ufarmFund()
    const fund_instance = (await hre.ethers.getContractAt('UFarmFund', fund)) as UFarmFund


    if (minFundDeposit.gt(0)) {
        console.log('Minimum fund deposit is not zero, depositing...')
        await(await fund_instance.depositToPool(pool, minFundDeposit)).wait()
        console.log('Deposit done')
    }

	const event = await getEventFromTx(
		pool_admin_instance.changePoolStatus(constants.Pool.State.Active),
		pool_instance,
		'PoolStatusChanged',
	)

	if (!event) {
		throw new Error('Pool activation failed')
	} else {
		console.log('Pool activated')
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})
