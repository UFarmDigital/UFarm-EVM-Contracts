// SPDX-License-Identifier: BUSL-1.1

import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { 
    isTestnet, 
    deployContract, 
    deployUpgradedContract,
    getDeployerSigner, 
    deployProxyContract, 
    _deployTags, 
    getInstanceFromDeployment,
    retryOperation
} from '../scripts/_deploy_helpers'
import { Guard, UFarmCore } from '../typechain-types'

const deployArbitraryController: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {

    const deployerSigner = await getDeployerSigner(hre)

    ////////////////////////// GUARD //////////////////////////
    console.log('\nDeploying Guard...')  
    const guard = await deployProxyContract(
        hre, 
        'Guard', 
        deployerSigner, 
        undefined, 
        {kind: 'uups',}
    )
    console.log(`Guard deployed at: ${guard.address}`)
    // GUARD INIT
    const ufarmCore_instance = (getInstanceFromDeployment<UFarmCore>(hre, await hre.deployments.get('UFarmCore'))).connect(deployerSigner) 
    const guard_instance = (getInstanceFromDeployment<Guard>(hre, await hre.deployments.get('Guard'))).connect(deployerSigner) 
    if (await guard_instance.ufarmCore() !== ufarmCore_instance.address) {
        console.log('\nInitializing Guard...')   
        await retryOperation(async () => {
            await hre.deployments.execute(
                'Guard',
                {
                    from: deployerSigner.address,
                    log: true,
                },
                '__init__Guard',
                ufarmCore_instance.address,
            )
        }, 3)
        console.log('Guard initialized!')
    }


    ////////////////// ARBITRARY CONTROLLER //////////////////
    console.log('\nDeploying ArbitraryController...')
    await deployUpgradedContract(hre, {
        deploymentName: 'ArbitraryController',
        from: deployerSigner.address,
        args: [
            guard.address,
        ],
        log: true,
        skipIfAlreadyDeployed: true,
        contract: 'ArbitraryController',
        estimateGasExtra: 100000,
    })
    console.log(`\n`)

}

export default deployArbitraryController
deployArbitraryController
deployArbitraryController.tags = _deployTags(['ArbitraryController'])
