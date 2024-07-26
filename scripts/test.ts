// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import hre from 'hardhat'
import {
	MintableToken,
	_prepareInvite,
	_signWithdrawRequest,
	bitsToBigNumber,
	constants,
	encodePoolAddLiqudityDataAsIsUniswapV2,
	encodePoolAddLiqudityDataUniswapV2,
	encodePoolSwapDataUniswapV2,
	get1InchResult,
	getBlockchainTimestamp,
	getEventFromTx,
	mintAndCreatePairUniV2,
	mintAndDeposit,
	prepareWithdrawRequest,
} from '../test/_helpers'
import {
	IERC20,
	IERC20Metadata,
	PoolAdmin,
	PriceOracle,
	StableCoin,
	UFarmCore,
	UFarmFund,
	UFarmPool,
	UniswapV2Factory,
	UniswapV2Factory__factory,
	UniswapV2Pair,
	UniswapV2Pair__factory,
	UniswapV2Router02,
	UnoswapV2Controller,
} from '../typechain-types'

import { BigNumber, BigNumberish, Contract } from 'ethers'
import { customSetTimeout, getInstanceFromDeployment, retryOperation } from './_deploy_helpers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'

async function main() {
	console.log('Starting')
	const { deployer, fundOwner } = await hre.getNamedAccounts()

	const USDCaddr = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
	const USDTaddr = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
	const DOLAaddr = '0x6a7661795c374c0bfc635934efaddff3a7ee23b6'

	const response = await get1InchResult(USDTaddr, DOLAaddr, BigNumber.from(10).pow(6))

	console.log(`1inch response: ${JSON.stringify(response, null, 2)}`)

	console.log('END OF SCRIPT')
	process.exit(0)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
