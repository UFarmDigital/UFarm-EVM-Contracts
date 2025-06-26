// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { QuexCore } from '../typechain-types'

async function main() {
	const { QuexCore, pool, amount } = {
		QuexCore: '0x4Ed57f8B8dfa2E975f55514c0dAB6D156D4dB2F8',
		pool: '0x4f1aEcF728190d8994af08E5dDe9c9D7b4e8597E',
		amount: 2_500_000_000, // $2,500
	}

	const quexCore_instance = (await hre.ethers.getContractAt('QuexCore', QuexCore)) as QuexCore

	try {
        const lastRequestId = await quexCore_instance.lastRequestId()
        console.log(`last req: ${lastRequestId}`)

        let tx;
		if(amount === null) {
			tx = await quexCore_instance.sendMockResponse(pool);
		} else {
			tx = await quexCore_instance.sendResponse(pool, amount);
		}
        await tx.wait();
        console.log('QuexCore mock response sent successfully');
        console.log('Tx hash:', tx.hash);
    } catch (error: any) {
        console.error('Error sending mock response:', error);
    }
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})
