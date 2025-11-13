// SPDX-License-Identifier: UNLICENSED

import csv from 'csv-parser'
import fs from 'fs'
import {
	ArtifactData,
	DeployOptions,
	DeployResult,
	Deployment,
	ExtendedArtifact,
} from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment, Network } from 'hardhat/types'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
	DeployProxyOptions,
	UpgradeProxyOptions,
	DeployBeaconOptions,
	UpgradeBeaconOptions,
} from '@openzeppelin/hardhat-upgrades/src/utils'
import { Signer, BigNumber, BaseContract, ContractFactory } from 'ethers'
import { BigNumberish } from '@ethersproject/bignumber'
import {
	AggregatorV2V3Interface,
	IERC20Metadata,
	IUFarmPool,
	UFarmCore,
	UFarmFund,
	UFarmFund__factory,
	UFarmPool,
	UFarmPool__factory,
	UFarmOwnableUUPS,
} from '../typechain-types'
import {
	AssetWithPriceFeed,
	bigNumberToBits,
	constants,
	deployPool,
	getEventFromTx,
	getFieldsByValue,
	MintableToken,
	mintTokens,
	PoolAndAdmin,
	tokenToPriceFeedStruct,
} from '../test/_helpers'
import { ethers } from 'hardhat'
import { ADDRESS_ZERO } from '@uniswap/v3-sdk'
export type TokenData = {
	name: string
	rawName: string
	symbol: string
	decimals: number
}

export type NamedSigner = string

export type NamedDeployedOptions = DeployOptions & { deploymentName: string } & {
	contract: string | ArtifactData
}

export interface TokenMetadata {
	name: string
	rawName: string
	symbol: string
	decimals: number
}

interface TokenTicker {
	ticker: string
}

export interface NetworkAddressRow {
	[key: string]: string | undefined
}

type TokensRow = NetworkAddressRow &
	TokenTicker & {
		name: string
		decimals: number
	}

enum DeployTags {
	// External deployments
	Tokens,
	Lido,
	Multicall3,
	UniV2,
	UniV2Pairs,
	MockedAggregators,
	UniV3,
	UniV3Pairs,
	OneInch,
	QuexCore,
	QuexPool,
	// Internal deployments
	WstETHOracle,
	PriceOracle,
	UFarmPool,
	PoolAdmin,
	UFarmCore,
	UFarmFund,
	PoolFactory,
	FundFactory,
	UniV2Controller,
	UniV3Controller,
	OneInchV5Controller,
	ArbitraryController,
	// Actions
	InitializeUFarm,
	WhiteListTokens,
	WhitelistControllers,
	PrepareEnvARB,
	ProductionENV,
	TestEnv,
	SepoliaEnv,
	Update1inchArb,
}

export function getNewContractName(controllerName: string) {
	return `${controllerName}_NEW`
}

export enum NetworkTypes {
	Arbitrum = 'arbitrum',
	ArbitrumSepolia = 'arbitrumSepolia',
	Dev = 'dev',
	Ethereum = 'ethereum',
}
export function getNetworkType(network: Network) {
	if (network.tags['arbitrum']) {
		return NetworkTypes.Arbitrum
	} else if (network.tags['arbitrumSepolia']) {
		return NetworkTypes.ArbitrumSepolia
	} else if (network.tags['ethereum']) {
		return NetworkTypes.Ethereum
	} else {
		return NetworkTypes.Dev
	}
}

export function _deployTags(tags: (keyof typeof DeployTags)[]): string[] {
	if (tags.length === 0) {
		return []
	}
	return tags.map((tag) => tag.toString())
}

async function readCSV<T>(path: string, filtr: (row: T) => boolean = () => true): Promise<T[]> {
	try {
		const parsed: T[] = []
		console.log('Reading CSV file:', path)

		await new Promise<void>((resolve, reject) => {
			console.log('Reading CSV file...')
			const stream = fs
				.createReadStream(path, { encoding: 'utf8' })
				.pipe(csv())
				.on('data', (row: T) => {
					// console.log(`push`)
					parsed.push(row)
				})
				.on('end', () => {
					resolve()
				})
				.on('error', (error: any) => {
					console.error('Error processing CSV file:', error)
					reject(error)
				})
		})

		return parsed.filter(filtr)
	} catch (e) {
		throw new Error(`Error reading CSV file: ${e}`)
	}
}

export const getPriceOracleContract = (network: Network) => {
	switch (getNetworkType(network)) {
		case 'arbitrum':
		case 'ethereum':
			return {
				contract: 'PriceOracle',
				args: { _quexCore: '0x97076a3c0A414E779f7BEC2Bd196D4FdaADFDB96' },
				initFunc: '__init__PriceOracle',
			}
		default:
			console.log('THIS IS NOT ARB')
			return {
				contract: 'PriceOracle',
				args: { _quexCore: null },
				initFunc: '__init__PriceOracle',
			}
	}
}

export const updateFundPermissionsIfNotYet = async (
	fund: UFarmFund,
	fundMember: string,
	permissions: BigNumberish,
) => {
	const hasPermissions = await fund.hasPermissionsMask(fundMember, permissions)
	if (!hasPermissions) {
		await retryOperation(async () => {
			await updateFundPermissions(fund, fundMember, permissions)
		}, 3)
		console.log(` - ${fundMember} permissions updated`)
	} else {
		console.log(` - ${fundMember} already has permissions in Fund(${fund.address})`)
	}
}

export async function updateFundPermissions(
	fundWithSigner: UFarmFund,
	address: string,
	permissions: BigNumberish,
) {
	const receipt = await fundWithSigner.updatePermissions(address, permissions)

	const permissionsString = getFieldsByValue(
		constants.Fund.Permissions,
		bigNumberToBits(BigNumber.from(permissions)),
	).join(', ')

	console.log(`` + `Addr: [${address}]\nPermissions: [${permissionsString}]\n-----------------`)
	return receipt.wait()
}

export async function customSetTimeout(seconds: number): Promise<void> {
	console.log(`Waiting ${seconds} seconds...`)
	return new Promise<void>((resolve) => {
		const milliseconds = seconds * 1000 // Convert seconds to milliseconds
		setTimeout(() => {
			resolve()
		}, milliseconds)
	})
}

export async function getPrefixedTokens(hre: HardhatRuntimeEnvironment) {
	const deploy_constants = hre.testnetDeployConfig as {
		tokens: {
			testnet: Array<{
				name: string
				rawName: string
				symbol: string
				decimals: number
			}>
		}
	}
	let tokens: typeof deploy_constants.tokens.testnet = []

	if (isTestnet(hre.network)) {
		tokens = deploy_constants.tokens.testnet
	} else {
		const networkType = getNetworkType(hre.network)
		const addressField : string = networkType
		if (networkType !== NetworkTypes.Arbitrum && networkType !== NetworkTypes.Ethereum) {
			throw new Error(`This script is not meant to be run on this network: ${hre.network.name}`)
		}

		const staticConfig = await getStaticConfig(addressField)
		const pendingTokens = staticConfig.tokens
		try {
			const tokensToWhitelist = pendingTokens.filter(
				(token) =>
					!(token.ticker.toUpperCase() === 'STETH'),
			)
			for (let i = 0; i < tokensToWhitelist.length; i++) {
				const token = tokensToWhitelist[i]
				const tokenAddress = token[addressField]
				if (!tokenAddress || tokenAddress.length === 0) continue

				try {
					const rawName = token.ticker.toUpperCase()

					const contract = (await hre.ethers.getContractAt(
						'@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
						tokenAddress,
					)) as IERC20Metadata

					const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()])
					const tokenData = {
						name: token.name,
						rawName: rawName,
						symbol: symbol,
						decimals: decimals,
					}
					console.log(`Fetched metadata for token ${token.name}:`, tokenData)
					tokens.push(tokenData)
				} catch (error) {
					console.error(`Error fetching metadata for token ${token.name}:`, error)
					throw error
				}
				await customSetTimeout(0.5)
			}
		} catch (error) {
			console.error('Error fetching token metadata:', error)
			throw error
		}
	}

	tokens.forEach((token) => {
		token.name = `${token.rawName}`
		token.symbol = `${token.rawName}`
	})

	return tokens
}

export async function getTokenDeployments(hre: HardhatRuntimeEnvironment) {
	const tokenDeployments: Record<string, Deployment> = {}

	const tokens = await getPrefixedTokens(hre)
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		const savedDeployment = await hre.deployments.getOrNull(token.rawName)
		if (savedDeployment) {
			tokenDeployments[token.rawName] = savedDeployment
		} else {
			throw new Error(`No deployment found for ${token.name}`)
		}
	}
	return tokenDeployments
}

export function isPublicTestnet(thisNetwork: Network) {
	return thisNetwork.tags['public'] && thisNetwork.tags['test']
}

export function isMainnet(thisNetwork: Network) {
	return thisNetwork.tags['mainnet']
}

export function isTestnet(thisNetwork: Network) {
	return thisNetwork.tags['test']
}

async function getFactoryOfContract(
	hre: HardhatRuntimeEnvironment,
	contract: string | ArtifactData,
) {
	if (typeof contract === 'string') {
		return await hre.ethers.getContractFactory(contract)
	} else {
		return new ContractFactory(contract.abi, contract.bytecode)
	}
}

async function getArtifactOfContract(
	hre: HardhatRuntimeEnvironment,
	contract: string | ArtifactData,
) {
	if (typeof contract === 'string') {
		return await hre.artifacts.readArtifact(contract)
	} else {
		console.error(`Unknown type ${typeof contract} for fetching artifcat`)
		return null
	}
}

export async function deployUpgradedContract(
	hre: HardhatRuntimeEnvironment,
	args: NamedDeployedOptions,
): Promise<
	| { existingDeployment: Deployment; newDeployment: null }
	| { existingDeployment: null; newDeployment: Deployment }
	| { existingDeployment: Deployment; newDeployment: Deployment }
> {
	const existingDeployment = await hre.deployments.getOrNull(args.deploymentName)
	if (existingDeployment) {
		const bytecode = await hre.ethers.provider.getCode(existingDeployment.address)
		const artifact = await getArtifactOfContract(hre, args.contract)
		const newContractName = getNewContractName(args.deploymentName)

		if (bytecode === artifact?.deployedBytecode) {
			console.log(`Contract ${args.deploymentName} already deployed.\n`)
			return { existingDeployment, newDeployment: null }
		} else {
			const existingUpgradedController = await hre.deployments.getOrNull(newContractName)
			if (existingUpgradedController) {
				console.log(`Contract ${newContractName} already deployed.\n`)
				return { existingDeployment, newDeployment: existingUpgradedController }
			} else {
				console.log(`Contract ${args.deploymentName} needs upgrade, deploying new version...`)
				const newDeployment = await deployContract(hre, {
					...args,
					deploymentName: newContractName,
				})
				console.log(`Deployed ${newContractName} at ${newDeployment.address}`)
			}
		}

		const newDeployment = await hre.deployments.getOrNull(newContractName)
		return { existingDeployment, newDeployment }
	} else {
		console.log(`Deploying ${args.deploymentName}...`)
		const newDeployment = await deployContract(hre, args)
		console.log(`Deployed ${args.deploymentName} at ${newDeployment.address}`)
		return { existingDeployment: null, newDeployment }
	}
}

export async function replaceUpdatedContract(
	hre: HardhatRuntimeEnvironment,
	contractName: string,
): Promise<void> {
	const newContractName = getNewContractName(contractName)
	const oldContractDeployment = await hre.deployments.get(contractName)
	const newContractDeployment = await hre.deployments.getOrNull(newContractName)

	if (!newContractDeployment) {
		return
	}

	try {
		// Delete the old contract deployment
		await hre.deployments.delete(contractName)

		// Save the new contract deployment
		await hre.deployments.save(contractName, newContractDeployment)

		// Delete the temporary new contract deployment
		await hre.deployments.delete(newContractName)

		console.log(
			`Replaced contract deployment of ${contractName} to newly deployed ${newContractDeployment.address} ...`,
		)
	} catch (error) {
		// Revert the old contract deployment
		await hre.deployments.save(contractName, oldContractDeployment)
	}
}

export async function trySaveDeployment(
	deploymentName: string,
	args: NamedDeployedOptions & { address: string },
	hre: HardhatRuntimeEnvironment,
): Promise<(ExtendedArtifact & { address: string }) | undefined> {
	const attempts = 3

	let deployment: (ExtendedArtifact & { address: string }) | undefined = {
		abi: [''],
		bytecode: '',
		address: '',
	}

	for (let currentAttempt = 0; currentAttempt < attempts; currentAttempt++) {
		try {
			const contractHasCode = (await hre.ethers.provider.getCode(args.address)) !== '0x'
			if (!contractHasCode) {
				const errorText = `Contract ${deploymentName} at ${args.address} has no code`
				console.error(errorText)
				throw new Error(errorText)
			}
			if (typeof args.contract !== 'string') {
				const errorText = `Contract is not a string, can't fetch ABI`
				console.error(errorText)
				throw new Error(errorText)
			}
			const contractArtifact = await hre.deployments.getExtendedArtifact(args.contract)
			deployment = {
				...contractArtifact,
				address: args.address,
			}

			break
		} catch (error) {
			console.warn(`Could not save ${args.deploymentName} on attempt ${currentAttempt + 1}`)
			await customSetTimeout(5 * currentAttempt + 1)
			if (currentAttempt === attempts - 1) {
				throw new Error(`Could not save ${args.deploymentName}` + `\n` + error)
			}
		}
	}
	if (!ethers.utils.isAddress(deployment.address)) {
		throw new Error(`Could not save ${args.deploymentName}.`)
	}
	await hre.deployments.save(deploymentName, deployment)
	console.log(`Saved ${deploymentName} at ${args.address}`)

	return deployment
}

export const getStaticConfig = async (addressField: string) => {
	const tokens = await readCSV(
		'./deploy-data/tokens.csv',
		(row: TokensRow) =>
			row.name !== '' &&
			row.decimals !== 0 &&
			ethers.utils.isAddress((row[addressField] ?? '') as string),
	)

	return {
		tokens,
	}
}

export async function tryDeploy(
	deploymentName: string,
	args: NamedDeployedOptions,
	hre: HardhatRuntimeEnvironment,
) {
	const attempts = 3

	let deployment: DeployResult | undefined = undefined

	for (let currentAttempt = 0; currentAttempt < attempts; currentAttempt++) {
		try {
			deployment = await hre.deployments.deploy(deploymentName, args)
			break
		} catch (error) {
			console.warn(`Could not deploy ${args.deploymentName} on attempt ${currentAttempt + 1}`)
			await customSetTimeout(5 * currentAttempt + 1)
			if (currentAttempt === attempts - 1) {
				throw new Error(`Could not deploy ${args.deploymentName}` + `\n` + error)
			}
		}
	}

	if (!deployment) {
		throw new Error(`Could not deploy ${args.deploymentName}`)
	}

	return deployment
}

export async function retryOperation<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
	let lastError: Error | undefined

	for (let retries = 1; retries < maxRetries + 1; retries++) {
		try {
			return await fn()
		} catch (error) {
			lastError = error as Error
			console.error(`Retry ${retries}: Operation failed with error: ${lastError.message}`)
			await customSetTimeout(5 * retries)
		}
	}

	if (lastError) {
		throw new Error(`Operation failed after max retries: ${lastError.message}`)
	} else {
		throw new Error(`Operation failed after max retries.`)
	}
}

export async function runDeployTag(hre: HardhatRuntimeEnvironment, tag: keyof typeof DeployTags) {
	await hre.run('deploy', { tags: tag.toString(), noCompile: true })
}

export async function getDeployerSigner(hre: HardhatRuntimeEnvironment) {
	const { getNamedAccounts } = hre
	const { deployer } = await getNamedAccounts()
	return hre.ethers.getSigner(deployer)
}

export async function getSignerByName(hre: HardhatRuntimeEnvironment, name: string) {
	const { getNamedAccounts } = hre
	const { [name]: address } = await getNamedAccounts()
	return hre.ethers.getSigner(address)
}

export async function getSignersByNames(hre: HardhatRuntimeEnvironment, names: string[]) {
	const { getNamedAccounts } = hre
	const namedAccounts = await getNamedAccounts()
	const signers: SignerWithAddress[] = []
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		const address = namedAccounts[name]
		const signer = await hre.ethers.getSigner(address)
		signers.push(signer)
	}
	return signers
}

export async function deployContract(hre: HardhatRuntimeEnvironment, args: NamedDeployedOptions) {
	const deployment = await tryDeploy(args.deploymentName, args, hre)
	// TODO: add return instance option
	return deployment
}

export async function deployProxyContract(
	hre: HardhatRuntimeEnvironment,
	contractName: string,
	signer: SignerWithAddress,
	args?: unknown[] | undefined,
	opts?: DeployProxyOptions | UpgradeProxyOptions | undefined,
	deploymentName?: string,
): Promise<DeployResult> {
	let instance : UFarmOwnableUUPS | null = null

	const thisDeploymentName = deploymentName || contractName
	const existingDeployment = await hre.deployments.getOrNull(thisDeploymentName)
	const contractArtifact = await hre.artifacts.readArtifact(contractName)
	const contractFactory = new hre.ethers.ContractFactory(
		contractArtifact.abi,
		contractArtifact.bytecode,
		signer,
	)

	if (existingDeployment) {
		const existingInstance = await hre.ethers.getContractAt('UFarmOwnableUUPS', existingDeployment.address)
		const instanceOwner = await existingInstance.owner()

		if (instanceOwner != ADDRESS_ZERO) {
			const currentImplAddress = await hre.upgrades.erc1967.getImplementationAddress(existingDeployment.address)
			const currentImplCode = await hre.ethers.provider.getCode(currentImplAddress)
			const currentImplHash = hre.ethers.utils.keccak256(currentImplCode)

			const nextImplRuntime = contractArtifact.deployedBytecode
			const nextImplHash =
				nextImplRuntime && nextImplRuntime.length > 2
					? hre.ethers.utils.keccak256(nextImplRuntime)
					: null

			if (nextImplHash && currentImplHash !== nextImplHash) {
				console.log(
					`Upgrading proxy ${thisDeploymentName} implementation: ${existingDeployment.address} -> ${currentImplAddress}`,
				)
				instance = (await retryOperation(async () => {
					return await hre.upgrades.upgradeProxy(existingDeployment.address, contractFactory, opts)
				}, 3)) as UFarmOwnableUUPS
			} else {
				console.log(
					`Skipping upgrade for proxy ${thisDeploymentName}; implementation bytecode unchanged (${currentImplAddress})`,
				)
			}
		}
	} else {
		console.log("Deploy the proxy")
		instance = await retryOperation(async () => {
			return await hre.upgrades.deployProxy(contractFactory, args, opts)
		}, 3) as UFarmOwnableUUPS
	}

	if (instance) {
		const artifact = await hre.deployments.getExtendedArtifact(contractName)

		const deployment = {
			...artifact,
			address: instance.address,
		}
		await hre.deployments.save(thisDeploymentName, deployment)
		console.log(`Deployed/upgraded at ${instance.address} (owner ${await instance.owner()})`)
	}

	return { ...(await hre.deployments.get(thisDeploymentName)), newlyDeployed: !!instance }
}

export async function deployBeaconContract(
	hre: HardhatRuntimeEnvironment,
	contractName: string,
	signer: SignerWithAddress,
	opts?: DeployBeaconOptions | UpgradeBeaconOptions | undefined,
): Promise<DeployResult> {
	let instance = null

	const existingDeployment = await hre.deployments.getOrNull(contractName)
	const contractArtifact = await hre.artifacts.readArtifact(contractName)
	const contractFactory = new hre.ethers.ContractFactory(
		contractArtifact.abi,
		contractArtifact.bytecode,
		signer,
	)

	if (existingDeployment) {
		const implAddress = await hre.upgrades.beacon.getImplementationAddress(existingDeployment.address)
		const bytecode = await hre.ethers.provider.getCode(implAddress)

		const currentImplHash = hre.ethers.utils.keccak256(bytecode)
		const nextImplRuntime = contractArtifact.deployedBytecode
		const nextImplHash =
			nextImplRuntime && nextImplRuntime.length > 2
				? hre.ethers.utils.keccak256(nextImplRuntime)
				: null

		if (nextImplHash && currentImplHash !== nextImplHash) {
			console.log(`Upgrading already existing contract ${contractName}: ${existingDeployment.address}`)
			instance = await retryOperation(async () => {
				return await hre.upgrades.upgradeBeacon(existingDeployment.address, contractFactory, opts)
			}, 3)
		} else {
			console.log(
				`Skipping upgrade for ${contractName}; implementation bytecode unchanged (${implAddress})`,
			)
		}
	} else {
		console.log(`Deploying the new contract ${contractName}`)
		instance = await retryOperation(async () => {
			return await hre.upgrades.deployBeacon(contractFactory, opts)
		}, 3)
	}

	if (instance) {
		const artifact = await hre.deployments.getExtendedArtifact(contractName)

		const deployment = {
			...artifact,
			address: instance.address,
		}
		await hre.deployments.save(contractName, deployment)
	}

	return { ...(await hre.deployments.get(contractName)), newlyDeployed: !!instance }
}

export function getInstanceFromDeployment<T extends BaseContract>(
	hre: HardhatRuntimeEnvironment,
	deployment: Deployment,
	signer?: Signer | SignerWithAddress,
): T {
	return new hre.ethers.Contract(
		deployment.address,
		deployment.abi,
		signer || hre.ethers.provider,
	) as T
}

export async function getInstanceOfDeployed<T extends BaseContract>(
	hre: HardhatRuntimeEnvironment,
	deploymentName: string,
	signer?: Signer | SignerWithAddress,
): Promise<T> {
	const deployment = await hre.deployments.get(deploymentName)
	return getInstanceFromDeployment<T>(hre, deployment, signer)
}

export function mockedAggregatorName(tokenRawName: string, network: Network) {
	if (tokenRawName === 'WSTETH') {
		return 'WSTETHOracle'
	}
	return network.tags['mainnet']
		? `${tokenRawName.toUpperCase()}USDAggregator`
		: `Mocked${tokenRawName.toUpperCase()}USDAggregator`
}

export const getOrDeployPoolInstance = async (
	poolName: string,
	args: IUFarmPool.CreationSettingsStruct,
	fund: UFarmFund,
	hre: HardhatRuntimeEnvironment,
) => {
	hre.network.name
	const poolDeployment = await hre.deployments.getOrNull(poolName)
	if (poolDeployment) {
		const pool = await getInstanceFromDeployment<UFarmPool>(hre, poolDeployment, fund.signer)
		const poolAdmin_addr = await pool.poolAdmin()
		const poolAdmin = await hre.ethers.getContractAt('PoolAdmin', poolAdmin_addr, fund.signer)
		console.log(`Pool ${poolName} already deployed at: ${pool.address}`)
		return {
			pool,
			admin: poolAdmin,
		} as PoolAndAdmin
	} else {
		const poolInstance = await deployPool(args, fund)
		console.log(`Pool ${poolName} deployed at: ${poolInstance.pool.address}`)
		await hre.deployments.save(poolName, {
			address: poolInstance.pool.address,
			abi: UFarmPool__factory.abi as unknown as any[],
		})
		return poolInstance
	}
}

export const deployFund = async (
	fundAdmin: string,
	core_instance: UFarmCore,
	hre: HardhatRuntimeEnvironment,
) => {
	try {
		const createFundEvent = await getEventFromTx(
			core_instance.createFund(
				fundAdmin,
				hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes('anyValueFromBackend')),
			),
			core_instance,
			'FundCreated',
		)

		const fundAddress = createFundEvent.args?.fund as string
		const fund_instance = new hre.ethers.Contract(fundAddress, UFarmFund__factory.abi) as UFarmFund

		return fund_instance
	} catch (error) {
		console.log(error)
		throw new Error('Could not get fund instance')
	}
}

export const deployOrGetFund = async (
	fundName: string,
	fundAdmin: string,
	core_instance: UFarmCore,
	hre: HardhatRuntimeEnvironment,
) => {
	const fundDeployment = await hre.deployments.getOrNull(fundName)
	if (fundDeployment) {
		const fund = await getInstanceFromDeployment<UFarmFund>(hre, fundDeployment)
		console.log(`Fund already deployed at: ${fund.address}`)
		return fund
	} else {
		const fund_instance = await deployFund(fundAdmin, core_instance, hre)

		console.log(`Fund deployed at: ${fund_instance.address}`)
		await hre.deployments.save(fundName, {
			address: fund_instance.address,
			abi: UFarmFund__factory.abi as unknown as any[],
		})
		return fund_instance
	}
}

export const activatePool = async (
	poolAndAdmin: PoolAndAdmin,
	tokenInstance: MintableToken,
	signer: SignerWithAddress,
	hre: HardhatRuntimeEnvironment,
) => {
	const currentPoolStatus = await poolAndAdmin.pool.status()
	const core_instance = await hre.ethers.getContractAt(
		'UFarmCore',
		await poolAndAdmin.pool.ufarmCore(),
	)
	const fund_instance = await hre.ethers.getContractAt(
		'UFarmFund',
		await poolAndAdmin.pool.ufarmFund(),
	)
	if (currentPoolStatus < constants.Pool.State.Active) {
		const minimumFundDeposit = await core_instance.minimumFundDeposit()
		const fundPoolBalance = await poolAndAdmin.pool.balanceOf(fund_instance.address)
		if (fundPoolBalance.eq(0) && !minimumFundDeposit.eq(0)) {
			const toDeposit = minimumFundDeposit.mul(2)
			await mintTokens(tokenInstance, toDeposit, signer)
			await (await tokenInstance.connect(signer).transfer(fund_instance.address, toDeposit)).wait()
			await (await fund_instance.depositToPool(poolAndAdmin.pool.address, toDeposit)).wait()
		}
		console.log(`Current pool status is ${currentPoolStatus}, setting to Active`)
		await (await poolAndAdmin.admin.changePoolStatus(constants.Pool.State.Active)).wait()
	} else {
		console.log(`Current pool (${poolAndAdmin.pool.address}) status is ${currentPoolStatus}`)
	}
}
export const checkMinFundDep = async (core_instance: UFarmCore, minimumDeposit: BigNumber) => {
	const minFundDep = await core_instance.minimumFundDeposit()
	if (!minFundDep.eq(minimumDeposit)) {
		console.log(`Current min fund deposit is ${minFundDep}, setting to ${minimumDeposit}`)
		console.log(`Min fund deposit set to ${minimumDeposit}`)
		return await (await core_instance.setMinimumFundDeposit(minimumDeposit)).wait()
	} else {
		console.log(`Current min fund deposit is ${minFundDep}`)
	}
}
export const getTokenFeed = async <T extends AggregatorV2V3Interface>(
	hre: HardhatRuntimeEnvironment,
	tokenRawName: string,
) => {
	const mockedAggregator = mockedAggregatorName(tokenRawName, hre.network)
	const aggregatorDeployment = await hre.deployments.get(mockedAggregator)
	const aggregatorInstance = getInstanceFromDeployment<T>(hre, aggregatorDeployment)
	const tokenInstance = await getInstanceOfDeployed<IERC20Metadata>(hre, tokenRawName)

	const [aggregatorDecimals, tokenDecimals] = await Promise.all([
		aggregatorInstance.decimals(),
		tokenInstance.decimals(),
	])

	return tokenToPriceFeedStruct(
		tokenInstance.address,
		tokenDecimals,
		aggregatorInstance,
		aggregatorDecimals,
	)
}

export const getWstETHTokenFeed = async <T extends AggregatorV2V3Interface>(
	hre: HardhatRuntimeEnvironment,
) => {
	const wsteth_instance = await getInstanceOfDeployed<IERC20Metadata>(hre, 'WSTETH')
	const wstethOracle_instance = await getInstanceOfDeployed<T>(hre, 'WSTETHOracle')

	const [wstethDecimals, wstethOracleDecimals] = await Promise.all([
		wsteth_instance.decimals(),
		wstethOracle_instance.decimals(),
	])

	return tokenToPriceFeedStruct(
		wsteth_instance.address,
		wstethDecimals,
		wstethOracle_instance,
		wstethOracleDecimals,
	)
}

const getFeedBySymbol = async <T extends AggregatorV2V3Interface>(
	symbol: string,
	hre: HardhatRuntimeEnvironment,
) => {
	if (symbol === 'WSTETH') {
		return getWstETHTokenFeed<T>(hre)
	} else {
		return getTokenFeed<AggregatorV2V3Interface>(hre, symbol)
	}
}

export const whitelistTokensWithAggregator = async <T extends AggregatorV2V3Interface>(
	hre: HardhatRuntimeEnvironment,
) => {
	const deployerSigner = await getDeployerSigner(hre)
	const tokenDeployments = await getTokenDeployments(hre)

	const ufarmCore_instance = getInstanceFromDeployment<UFarmCore>(
		hre,
		await hre.deployments.get('UFarmCore'),
	).connect(deployerSigner)

	console.log('\nWhitelisting tokens...')

	const tokensToWhitelist: Array<AssetWithPriceFeed> = []
	const tokensToUpdate: Array<AssetWithPriceFeed> = []

	for (let i = 0; i < Object.entries(tokenDeployments).length; i++) {
		const [token, deployment] = Object.entries(tokenDeployments)[i]
		console.log(`Prepairing ${token} with AggregatorV3 ...`)

		if (token === 'STETH') {
			console.log(`Skipping ${token} whitelist...`)
			continue
		}

		const tokenFeed = await getFeedBySymbol<T>(token, hre)

		const isTokenWhitelisted = await ufarmCore_instance.isTokenWhitelisted(deployment.address)
		if (isTokenWhitelisted) {
			const currentOracle = (await ufarmCore_instance.tokenInfo(deployment.address)).priceFeed
				.feedAddr
			if (currentOracle === tokenFeed.priceFeed.feedAddr) {
				console.log(`Token ${token} already whitelisted with correct oracle.`)
				continue
			} else {
				console.warn(`Token ${token} whitelisted with different oracle.`)
				tokensToUpdate.push(tokenFeed)
			}
		} else {
			tokensToWhitelist.push(tokenFeed)
		}

		await customSetTimeout(1)
	}

	if (tokensToWhitelist.length === 0) {
		console.log(`All tokens already whitelisted!`)
		return
	} else {
		console.log(`Whitelisting tokens: ${tokensToWhitelist.map((token) => token.assetAddr).join(', ')}`)

		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'whitelistTokens',
				tokensToWhitelist,
			)
		}, 3)

		console.log('Tokens whitelisted!')
	}

	if (tokensToUpdate.length === 0) {
		console.log(`Don't need to update any tokens.`)
		return
	} else {
		console.log(`Updating tokens: ${tokensToUpdate.map((token) => token.assetAddr).join(', ')}`)
		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'blacklistTokens',
				tokensToUpdate,
			)
		}, 3)

		console.log('Tokens blacklisted!')

		await retryOperation(async () => {
			await hre.deployments.execute(
				'UFarmCore',
				{
					from: deployerSigner.address,
					log: true,
				},
				'whitelistTokens',
				tokensToUpdate,
			)
		}, 3)

		console.log('Tokens updated!')
	}
}

export const whitelistValueTokens = async (
	hre: HardhatRuntimeEnvironment,
) => {
	const deployerSigner = await getDeployerSigner(hre)
	const tokenDeployments = await getTokenDeployments(hre)

	const ufarmCore_instance = getInstanceFromDeployment<UFarmCore>(
		hre,
		await hre.deployments.get('UFarmCore'),
	).connect(deployerSigner)

	console.log('\nWhitelisting value tokens...')

	// Filter for USDT and USDC tokens
	const valueTokenAddresses: string[] = []
	const valueTokenNames: string[] = ['USDT', 'USDC']

	for (const tokenName of valueTokenNames) {
		if (tokenDeployments[tokenName]) {
			valueTokenAddresses.push(tokenDeployments[tokenName].address)
			console.log(`Adding ${tokenName} as a value token...`)
		} else {
			console.warn(`Token ${tokenName} not found in deployments, skipping...`)
		}
	}

	if (valueTokenAddresses.length === 0) {
		console.log(`No value tokens to whitelist!`)
		return
	}

	// Check if tokens are already whitelisted as value tokens
	const tokensToWhitelist: string[] = []
	for (const tokenAddress of valueTokenAddresses) {
		const isValueTokenWhitelisted = await ufarmCore_instance.isValueTokenWhitelisted(tokenAddress)
		if (isValueTokenWhitelisted) {
			console.log(`Token ${tokenAddress} already whitelisted as a value token.`)
			continue
		}
		tokensToWhitelist.push(tokenAddress)
	}

	if (tokensToWhitelist.length === 0) {
		console.log(`All value tokens already whitelisted!`)
		return
	}

	console.log(`Whitelisting value tokens: ${tokensToWhitelist.join(', ')}`)

	await retryOperation(async () => {
		await hre.deployments.execute(
			'UFarmCore',
			{
				from: deployerSigner.address,
				log: true,
			},
			'whitelistValueTokens',
			tokensToWhitelist,
		)
	}, 3)

	console.log('Value tokens whitelisted!')
}
