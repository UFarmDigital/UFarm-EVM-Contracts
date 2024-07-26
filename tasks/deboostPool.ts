// SPDX-License-Identifier: UNLICENSED

import { task } from 'hardhat/config'
import { types } from 'hardhat/config'

task('deboostPool', 'Decreases exchange rate of pool in testnet')
	.addParam('pool', 'address of the pool', '0xPool', types.string)
	.setAction(async function (taskArgs, hre) {
		if (!hre.ethers.utils.isAddress(taskArgs.pool)) {
			if ((taskArgs.pool as string) === '0xPool') {
				console.log(
					`Default manager address was not set, manager will be a caller with address: ${taskArgs.pool}`,
				)
			} else {
				throw new Error(`Manager (${taskArgs.pool}) is not a proper EVM address.`)
			}
		}
		const [signer] = await hre.ethers.getSigners()
		console.log(
			`Signer addr:\n${await signer.getAddress()}\n`,
			`Signer balance:\n${await signer.getBalance()}\n`,
		)

		const pool_instance = await hre.ethers.getContractAt('UFarmPool', taskArgs.pool)
		const valueToken = await pool_instance.valueToken()
		const token_instance = await hre.ethers.getContractAt('StableCoin', valueToken)

		console.log(`Decreasing pool rate(${pool_instance.address})`)

		const initialTotalCost = await pool_instance.getTotalCost()
		const initialRate = await pool_instance.getExchangeRate()

		const ONE_HUNDRED_BUCKS = hre.ethers.utils.parseUnits('100', 6)
		const depositAmount = initialTotalCost.gt(ONE_HUNDRED_BUCKS)
			? initialTotalCost.div(5)
			: ONE_HUNDRED_BUCKS
		await (await token_instance.mint(signer.address, depositAmount)).wait()
		await (
			await token_instance.connect(signer).approve(pool_instance.address, depositAmount)
		).wait()
		await (await pool_instance.connect(signer).deposit(depositAmount)).wait()
        
        console.log(`Forcing withdrawal of ${depositAmount} from ${pool_instance.address} to ${signer.address}`)
		await token_instance.forceWithdrawal(pool_instance.address, signer.address, depositAmount)
		const rateAfterDeposit = await pool_instance.getExchangeRate()

		console.log(`Initial rate: ${initialRate} | Rate after deposit: ${rateAfterDeposit}`)
	})
