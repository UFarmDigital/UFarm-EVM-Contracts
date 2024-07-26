// SPDX-License-Identifier: UNLICENSED

import { task } from 'hardhat/config'
import { StableCoin, WETH9, WETH9__factory } from '../typechain-types'
import { types } from 'hardhat/config'

task('mint-tokens', 'Mints new tokens for a user')
	.addParam('token', 'address of the token', '0xtoken', types.string)
	.addParam('user', 'address of the user', '0xuser', types.string)
	.addParam('amount', 'amount of the token', '1000000', types.string)
	.addOptionalParam('isweth', 'is the token weth', false, types.boolean)
	.setAction(async function (
		{ token, user, amount, isweth },
		{ ethers: { getContractAt, BigNumber, utils, provider } },
	) {
		const signer = provider.getSigner(0)

		console.log(
			`Signer addr:\n${await signer.getAddress()}\n`,
			`Signer balance:\n${await signer.getBalance()}\n`,
		)

		if (!utils.isAddress(token)) {
			throw new Error(`Token (${token}) is not a proper EVM address.`)
		}

		if (!utils.isAddress(user)) {
			throw new Error(`User (${user}) is not a proper EVM address.`)
		}

		const amountToMint = (amount: any) => {
			return BigNumber.from(amount)
		}

		console.log(`User:\n${user}\n`, `Amount to mint:\n${amountToMint(amount)}\n`)

		const isWeth = isweth as boolean

		const getMintTx = async () => {
			if (isWeth) {
				console.log(`Token is WETH`)
				const WETH = await getContractAt('WETH9', token, signer) as WETH9
				const estimatedGas = await WETH.estimateGas.deposit({ value: amountToMint(amount) })
				return WETH.deposit({ value: amountToMint(amount), gasLimit: estimatedGas.mul(2) })
			} else {
				const Stable = (await getContractAt('StableCoin', token, signer)) as StableCoin
				const estimatedGas = await Stable.estimateGas.mint(user, amountToMint(amount))
				return Stable.mint(user, amountToMint(amount), { gasLimit: estimatedGas.mul(2) })
			}
		}

		const tx = await getMintTx()
		const receipt = await tx.wait()

		const event = receipt.events?.find((e) => e.event === (isWeth ? 'Deposit' : 'Transfer'))

		if (event) {
			console.log(`Minted ${amount} tokens to ${user}`)
		} else {
			throw new Error(`Failed to mint ${amount} tokens to ${user}`)
		}
	})
