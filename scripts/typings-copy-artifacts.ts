// SPDX-License-Identifier: UNLICENSED

import fs from 'fs'
import path from 'path'

const sourceDirectories = [
	'./artifacts/contracts/main/contracts',
	'./artifacts/@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol',
	'./artifacts/contracts/test/UniswapV3/@uniswap/v3-core/contracts/UniswapV3Pool.sol',
    './artifacts/contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/SwapRouter.sol',
    './artifacts/contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol',
    './artifacts/contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/lens/QuoterV2.sol',
    './artifacts/contracts/test/UniswapV3/@uniswap/v3-core/contracts/UniswapV3Factory.sol',
]
const targetDirectory = './ufarm-evm-typings/build/artifacts'

// Ensure target directory exists or create it
if (!fs.existsSync(targetDirectory)) {
	fs.mkdirSync(targetDirectory, { recursive: true })
}

// Read all subdirectories inside the source directory
for (const sourceDirectory of sourceDirectories) {
	if (!fs.existsSync(sourceDirectory)) {
		console.warn(`Skipping source directory ${sourceDirectory}`)
		continue
	}

	const solDirs = getAllSolFolders(sourceDirectory)

	solDirs.forEach((contractDir) => {
		const contractName = contractDir.split('.sol')[0].split('/').pop()

		if (contractName) {
			const rootContractDir = contractDir.split('.sol')[0].slice(0, -contractName.length)

			const sourceFile = path.join(contractDir, contractName + '.json')

			const isInterface = contractName[0] == 'I' && contractName[1] == contractName[1].toUpperCase()
			if (isInterface) {
				const nonInterfaceSourceDir = path.join(
					rootContractDir,
					contractName.slice(1) + '.sol',
				)

                if (fs.existsSync(nonInterfaceSourceDir) && solDirs.includes(nonInterfaceSourceDir)) {
                    console.log(`Skipping interface of ${contractName} in favor of ${nonInterfaceSourceDir}`)
                    return
                }
			}

			// Skip if file doesn't exist
			if (!fs.existsSync(sourceFile)) {
				console.warn(`Skipping ${sourceFile}`)
				return
			}
			const targetFile = path.join(targetDirectory, '/', contractName + '.json')
			console.log(`Copying ${sourceFile} to ${targetFile}`)
			fs.copyFileSync(sourceFile, targetFile)
		}
	})
}
function getAllSolFolders(dir: string, solFolders: string[] = []): string[] {
	if (dir.endsWith('.sol')) {
		solFolders.push(dir)
	}
	const files = fs.readdirSync(dir)

	for (const file of files) {
		const filePath = path.join(dir, file)
		const stat = fs.statSync(filePath)

		if (stat.isDirectory()) {
			getAllSolFolders(filePath, solFolders)
		} else if (file.endsWith('.sol')) {
			const folder = path.dirname(filePath)
			if (!solFolders.includes(folder)) {
				solFolders.push(folder)
			}
		}
	}

	return solFolders
}
