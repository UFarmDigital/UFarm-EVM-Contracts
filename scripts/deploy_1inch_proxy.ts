// SPDX-License-Identifier: UNLICENSED

import hre from 'hardhat'
import { BigNumberish } from 'ethers'
import { UFarmPool, StableCoin, UFarmFund, OneInchV5Controller__factory } from '../typechain-types'
import { PoolCreationStruct, constants, encodePoolOneInchSwap, getEventFromTx } from '../test/_helpers'
import { IERC20Metadata } from '../typechain-types/@openzeppelin/contracts/token/ERC20/extensions'


// args:                    (0xe6e40dcfe2607f89f8642ab4a065a8e8605a1a57c2cc8d316950366809a262fc, 0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c80502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000000000000000000000000000000000000098214f00000000000000000000000000000000000000000000000000000000009627d20000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d03403041cbd36888becc7bbcbc0045e3b1f144466f5f8b1ccac8000000000000000000000000000000000000000000000000)

async function main() {
	const [deployer] = await hre.ethers.getSigners()
    console.log(`Deplyer address: ${deployer.address}`)

	const aggregationRouterV5_orig = '0x1111111254eeb25477b68fb85ed929f73a960582'
    const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const usdtAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7'
    const usdtHolderAddr = '0xDFd5293D8e347dFe59E90eFd55b2956a1343963d'
    const oneInchTx = `0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c80502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec70000000000000000000000000000000000000000000000000000000005f19b4a0000000000000000000000000000000000000000000000000000000005dfb5bd0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d03403041cbd36888becc7bbcbc0045e3b1f144466f5f8b1ccac8000000000000000000000000000000000000000000000000`
// 0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000e4f78dc253000000000000000000000000cd8fc37291cb0e7ea855b58377adc7bccdad46f900000000000000000000000010c12d979b9e48f208f530ec5f3ea67837a4f8220000000000000000000000000000000000000000000000000000000002faf08000000000000000000000000000000000000000000000000000626340c0ec97ed00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000100000000000000003b6d034070831b48335d931e07b64ab0c7d28d5e0aec101c00000000000000000000000000000000000000000000000000000000
// 0x4c9ddf69000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c8
// 0502b1c5000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000000000000000000000000000000000000098214f00000000000000000000000000000000000000000000000000000000009627d20000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000180000000000000003b6d03403041cbd36888becc7bbcbc0045e3b1f144466f5f8b1ccac8000000000000000000000000000000000000000000000000`
    // const oneInchTx = '0xf91abd17000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000007aadfda890440000000000000000000000000000000000000000000000000000018e86d4a84500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000002000000000000000000000000bec08b12212b461e207ac0b5d6106d9dfe01282e00000000000000000000000026569e2199c92f8b7c3deb52f9b33aee257f9c76'

    // impersonate usdt holder
    const provider = new hre.ethers.providers.JsonRpcProvider(
        "http://localhost:8545"
      );
    await provider.send("hardhat_impersonateAccount", [usdtHolderAddr]);

    // hre.e
    // const account = provider.getSigner(usdtHolderAddr);

    // await hre.network.provider.request({
    //     method: 'hardhat_impersonateAccount',
    //     params: [usdtHolderAddr],
    // })
    const usdtHolder = await provider.getSigner(usdtHolderAddr)
    // console.log(`Impersonated usdt holder: ${usdtHolder.address}`)

    const usdtInstance = await hre.ethers.getContractAt('@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata', usdtAddress) as IERC20Metadata
    const usdcInstance = await hre.ethers.getContractAt('@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata', usdcAddress) as IERC20Metadata

	const oneInchControllerFactory = await hre.ethers.getContractFactory('InchSwapTestController')
    const testProxyFactory = await hre.ethers.getContractFactory('InchSwapTestProxy')

    const aggregationRouterV5Factory = await hre.ethers.getContractFactory('AggregationRouterV5')
    const aggregationRouterV5 = await aggregationRouterV5Factory.deploy('0xDFd5293D8e347dFe59E90eFd55b2956a1343963d')    
    console.log(`AggregationRouterV5 deployed at: ${aggregationRouterV5.address}`)

	const testController = await oneInchControllerFactory.deploy(aggregationRouterV5.address)
    console.log(`test controller deployed at: ${testController.address}`)

    const testProxy = await testProxyFactory.deploy()
    console.log(`TestProxy deployed at: ${testProxy.address}`)

    const usdtInitialBalance = await usdtInstance.balanceOf(testProxy.address)
    const usdcInitialBalance = await usdcInstance.balanceOf(testProxy.address)

    console.log(`usdt initial balance: ${usdtInitialBalance.toString()}`)
    console.log(`usdc initial balance: ${usdcInitialBalance.toString()}`)

    
    await testProxy.addController(constants.UFarm.prtocols.OneInchProtocolString, testController.address)
    console.log(`OneInchController added to TestProxy`)

    const usdtAmountOut = constants.ONE_HUNDRED_BUCKS.mul(2)
    if ((await usdtInstance.balanceOf(usdtHolderAddr)).lt(usdtAmountOut)) {
        throw new Error('usdtAmountOut is greater than balance of holder')
    }

    await (await usdtInstance.connect(usdtHolder).transfer(testProxy.address, usdtAmountOut)).wait()
    console.log(`Transferred ${usdtAmountOut} USDT to TestProxy`)

    // make approve from proxyContract
    // const encodedApproveToAggRouter = usdtInstance.interface.encodeFunctionData('approve', [aggregationRouterV5, hre.ethers.constants.MaxUint256])

    // await testProxy.executeAny(usdtAddress, encodedApproveToAggRouter)
    // console.log(`Approved ${usdtAmountOut} USDT to AggregationRouter from TestProxy`)

    // const originalControllerFactory = await hre.ethers.getContractFactory('InchSwapTestController')
    // const oneInchSwapCalldata = originalControllerFactory.interface.encodeFunctionData('delegated1InchSwap',[oneInchTx])
    console.log(`oneInchSwapCalldata: ${oneInchTx}`)
    // const oneInchSwapCalldata = encodePoolOneInchSwap(oneInchTx)
    await testProxy.protocolAction(constants.UFarm.prtocols.OneInchProtocolString, oneInchTx)
    console.log(`1inch swap executed`)

    const newUsdtBalance = await usdtInstance.balanceOf(usdtHolderAddr)
    const newUsdcBalance = await usdcInstance.balanceOf(testProxy.address)
    console.log(`usdt balance after swap: ${newUsdtBalance.toString()}`)
    console.log(`usdc balance after swap: ${newUsdcBalance.toString()}`)

}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
