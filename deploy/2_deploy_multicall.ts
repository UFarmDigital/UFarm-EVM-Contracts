// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { isTestnet, deployContract, getDeployerSigner, _deployTags } from '../scripts/_deploy_helpers'

const deployMulticall: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
	if (!isTestnet(hre.network)){
        console.log(`Skipping Multicall3 deployment`)
        return
    }

	const deployerSigner = await getDeployerSigner(hre)

    const deployerAddr = deployerSigner.address
    const deployerBalance = await deployerSigner.getBalance()
    console.log(`Deployer address: ${deployerAddr}\nDeployer balance: ${deployerBalance.toString()}`)

	console.log('\nDeploying Multicall3...')

    const multicallDeployment = await deployContract(hre, {
        deploymentName: 'Multicall3',
        from: deployerSigner.address,
        log: true,
        skipIfAlreadyDeployed: true,
        contract: 'Multicall3',
    })

	console.log('\n Multicall3 deployed!')
}

export default deployMulticall
deployMulticall.dependencies = []
deployMulticall.tags = _deployTags(['Multicall3'])
