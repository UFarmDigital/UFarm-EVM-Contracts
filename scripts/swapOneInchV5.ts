// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { BigNumber } from 'ethers'
import { UFarmPool, StableCoin } from '../typechain-types'
import {
	ISwapResponse,
	constants,
	encodePoolOneInchSwap,
	oneInchCustomUnoswapTo,
} from '../test/_helpers'
import { oneinchETHConstants } from '../test/_oneInchTestData'

async function main() {
	const {
		pool,
		tokenin,
		tokenout,
		amountin,
		amountoutmin,
		deadline,
		oneInchAddr,
		uniswapV2Router,
		uniswapV2Factory,
	} = {
		pool: '0x7f9B0a701882Dc9c904517533e27772905275112',
		tokenin: '0xd71fe004d84b10FbD161838F87A94f2327A315a1',
		tokenout: '0xeF8DF16e4BAe9582393Fd96099ed670526F09a8D',
		amountin: '1000000',
		amountoutmin: '1',
		deadline: Math.floor(Date.now() / 100 + 100).toString(),
		oneInchAddr: '0x001C073d1ed78a0aADc31f2D320300aE30D1a085', // Double check this address
		uniswapV2Router: '0xA37Fc726C2acc26a5807F32a40f7D2Fe7540F4cb',
		uniswapV2Factory: '0x2a973622751ce6Ae37b3567c328a78BC3A59A050',
	}
	console.log(deadline)

	const Pool = (await hre.ethers.getContractAt('UFarmPool', pool)) as UFarmPool

	const [tokenInstanceIn, tokenInstanceOut] = [
		(await hre.ethers.getContractAt('StableCoin', tokenin)) as StableCoin,
		(await hre.ethers.getContractAt('StableCoin', tokenout)) as StableCoin,
	]

	const [balanceInBefore, balanceOutBefore] = await Promise.all([
		tokenInstanceIn.balanceOf(Pool.address),
		tokenInstanceOut.balanceOf(Pool.address),
	])

	console.log(`Swapping ${amountin} ${tokenin} for at least ${amountoutmin} ${tokenout} on ${pool}`)

	const OneInchResponse = oneinchETHConstants.swap.usdt100_weth.response

	const injectedOneInchResponse = await oneInchCustomUnoswapTo(
		// OneInchResponse.request as ISwapRequest,
		OneInchResponse as ISwapResponse,
		oneInchAddr,
		amountin,
		Pool.address,
		[tokenInstanceIn.address, tokenInstanceOut.address],
		uniswapV2Router,
		uniswapV2Factory,
	)

	const oneInchSwapTxData = encodePoolOneInchSwap(injectedOneInchResponse.tx.data)

	const tx = await Pool.protocolAction(
		constants.UFarm.prtocols.OneInchProtocolString,
		oneInchSwapTxData,
	)
	const receipt = await tx.wait()

	const [balanceInAfter, balanceOutAfter] = await Promise.all([
		tokenInstanceIn.balanceOf(Pool.address),
		tokenInstanceOut.balanceOf(Pool.address),
	])

	console.log(
		`Swapped with tx hash: ${receipt.transactionHash}\nSpent ${balanceInBefore.sub(
			balanceInAfter,
		)} ${await tokenInstanceIn.symbol()} and received ${balanceOutAfter.sub(
			balanceOutBefore,
		)} ${await tokenInstanceOut.symbol()}`,
	)

	console.log('Swap operation complete.')
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error)
		process.exit(1)
	})
