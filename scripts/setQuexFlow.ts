// SPDX-License-Identifier: UNLICENSED

import hre, { ethers } from 'hardhat'
import { PriceOracle } from '../typechain-types'
import { HTTPRequestStruct } from '../typechain-types/contracts/test/Quex/QuexPool'

async function main() {
	const { PriceOracleAddress, QuexPool, patchId, schemaId, filterId  } = {
		PriceOracleAddress: '0x97a7eac59b0ee58f74573654fe44fad43e12dfe4',
		QuexPool: '0x957E16D5bfa78799d79b86bBb84b3Ca34D986439',
		patchId: 'patchId',
		schemaId: 'schemaId',
		filterId: 'filterId',
	}

	enum RequestMethod {
		Get,
		Post,
		Put,
		Patch,
		Delete,
		Options,
		Trace
	}

	const HTTPStruct: HTTPRequestStruct = { 
		method: RequestMethod.Get,
		path: "/v1/user/chain_balance",
		host: "pro-openapi.debank.com",
		headers: [
            {
                "key": "Content-Type",
                "value": "application/json"
            }
        ],
		parameters: [
            {
                "key": "chain_id",
                "value": "arb"
            }
        ],
		body: ethers.utils.toUtf8Bytes(''),
	}

	const patchIdBytes = ethers.utils.formatBytes32String(patchId)
	const schemaIdBytes = ethers.utils.formatBytes32String(schemaId)
	const filterIdBytes = ethers.utils.formatBytes32String(filterId)

	const PriceOracle_instance = (await hre.ethers.getContractAt('PriceOracle', PriceOracleAddress)) as PriceOracle

	try {
		const tx = await PriceOracle_instance.setQuexFlow(QuexPool, HTTPStruct, patchIdBytes, schemaIdBytes, filterIdBytes)

        await tx.wait();
        console.log('Quex Flow was set successfully');
        console.log('Tx hash:', tx.hash);
    } catch (error: any) {
        console.error('Error setting Quex Flow:', error);
    }
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})
