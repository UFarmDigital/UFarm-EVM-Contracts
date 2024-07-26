// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { BigNumber } from 'ethers'
import { UFarmPool, StableCoin } from '../typechain-types'
import { constants, encodePoolSwapDataUniswapV2 } from '../test/_helpers'

async function main() {
	const { pool, tokenin, tokenout, amountin, amountoutmin, deadline } = {
		pool: '0x7f9B0a701882Dc9c904517533e27772905275112',
		tokenin: '0xd71fe004d84b10FbD161838F87A94f2327A315a1',
		tokenout: '0xeF8DF16e4BAe9582393Fd96099ed670526F09a8D',
		amountin: '1000000',
		amountoutmin: '1',
		deadline: Math.floor(Date.now() / 100 + 100).toString(),
	}
	console.log(deadline)

	const [amountInB, amountOutMinB] = [BigNumber.from(amountin), BigNumber.from(amountoutmin)]

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

	const tx = await Pool.protocolAction(
		constants.UFarm.prtocols.UniswapV2ProtocolString,
		encodePoolSwapDataUniswapV2(amountInB, amountOutMinB, deadline, [
			tokenInstanceIn.address,
			tokenInstanceOut.address,
		]),
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
