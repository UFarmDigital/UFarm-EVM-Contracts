import * as dotenv from 'dotenv'
import { HardhatUserConfig, extendConfig, extendEnvironment } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import 'hardhat-docgen'
import '@dlsl/hardhat-markup'
import 'hardhat-deploy'
import '@openzeppelin/hardhat-upgrades'
import 'hardhat-dependency-compiler'
import 'hardhat-tracer'
import 'hardhat-contract-sizer'
import './tasks'
import 'hardhat-gas-reporter'

dotenv.config()

interface Token {
	name: string
	rawName: string
	symbol: string
	decimals: number
}

interface InitialRate {
	rawName0: string
	rawName1: string
	amount0: string
	amount1: string
}

interface Tokens {
	testnet: Token[]
}

interface IDeployConfig {
	tokens: Tokens
	initialRates: InitialRate[]
}

const LOW_OPTIMIZER_COMPILER_SETTINGS = {
	version: '0.8.15',
	settings: {
		optimizer: {
			enabled: true,
			runs: 2_000,
		},
		metadata: {
			bytecodeHash: 'none',
		},
	},
}

const LOWEST_OPTIMIZER_COMPILER_SETTINGS = {
	version: '0.8.15',
	settings: {
		viaIR: true,
		optimizer: {
			enabled: true,
			runs: 10,
		},
		metadata: {
			bytecodeHash: 'none',
		},
	},
}

const DEFAULT_COMPILER_SETTINGS_16 = {
	version: '0.8.16',
	settings: {
		optimizer: {
			enabled: true,
			runs: 1,
		},
	},
}

const DEFAULT_COMPILER_SETTINGS_20 = {
	version: '0.8.20',
	settings: {
		optimizer: {
			enabled: true,
			runs: 100_000,
		},
		metadata: {
			bytecodeHash: 'none',
		},
	},
}

const DEFAULT_COMPILER_SETTINGS_24 = {
	...DEFAULT_COMPILER_SETTINGS_20,
	version: '0.8.24',
}

const DEFAULT_COMPILER_SETTINGS_15 = {
	version: '0.8.15',
	settings: {
		optimizer: {
			enabled: true,
			runs: 1_000_000,
		},
		metadata: {
			bytecodeHash: 'none',
		},
	},
}

const DEFAULT_COMPILER_SETTINGS_12 = {
	version: '0.8.12',
	settings: {
		optimizer: {
			enabled: true,
			runs: 625,
		},
		metadata: {
			bytecodeHash: 'none',
		},
	},
}

const UFARM_POOL_COMPILER_SETTINGS = {
	...DEFAULT_COMPILER_SETTINGS_20,
	settings: {
		...DEFAULT_COMPILER_SETTINGS_20.settings,
		viaIR: true,
		optimizer: {
			enabled: true,
			runs: 55,
		},
	},
}

const UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS = {
	...DEFAULT_COMPILER_SETTINGS_24,
	settings: {
		...DEFAULT_COMPILER_SETTINGS_24.settings,
		viaIR: false,
		optimizer: {
			enabled: true,
			runs: 500,
		},
	},
}

const UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS = {
	...DEFAULT_COMPILER_SETTINGS_24,
	settings: {
		...DEFAULT_COMPILER_SETTINGS_24.settings,
		viaIR: true,
	},
}

const infuraApiKey: string = process.env.INFURA_API_KEY || ''
const quicknodeApiKey: string = process.env.QUICKNODE_API_KEY || ''
const arbitrumRPCURL: string = process.env.ARBITRUM_RPC_URL || ''
const isForking: boolean = process.env.FORKING === 'true'
const ufarmDevURL: string = process.env.UFARM_DEV_URL || ''
const ufarmDevChainID: number = parseInt(process.env.UFARM_DEV_CHAIN_ID || '1', 10)
const ufarmDemoURL: string = process.env.UFARM_DEMO_URL || ''
const ufarmDemoChainID: number = parseInt(process.env.UFARM_DEMO_CHAIN_ID || '1', 10)

const ufarmPanicManager: string = process.env.PANIC_MANAGER_ADDRESS || ''
const ufarmFundApprover: string = process.env.FUND_APPROVER_ADDRESS || ''
const ufarmManager: string = process.env.UFARM_MANAGER_ADDRESS || ''
const fundOwner: string = process.env.FUND_OWNER_ADDRESS || ''
const ufarmOwner: string = process.env.OWNER_ADDRESS || ''
const parsedMnemonic =
	process.env.TEST_MNEMONIC || 'test test test test test test test test test test test test'

const parsedDeploymentsJsonPath = process.env.DEPLOYMENTS_JSON ?? './deployments.json'

const mnemonicAccounts = {
	accounts: {
		mnemonic: parsedMnemonic,
		accounts: 11,
		path: `m/44'/60'/0'/0`,
		accountsBalance: '333333333333333333333333333333333333333',
	},
}

const networkConfig = (chainId: number, url: string | null | undefined, verifyKey?: string) => ({
	url: url || '',
	chainId: chainId,
	...mnemonicAccounts,
	verify: {
		etherscan: {
			apiKey: verifyKey ?? '',
		},
	},
})

const config: HardhatUserConfig = {
	networks: {
		hardhat: {
			allowUnlimitedContractSize: false,
			saveDeployments: true,
			chainId: 42161,
			forking: {
				enabled: false,
				url: `https://arbitrum-mainnet.infura.io/v3/${infuraApiKey}`,
			},
			autoImpersonate: true,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		localhost: {
			allowUnlimitedContractSize: false,
			saveDeployments: true,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		ufarmDemo: {
			url: ufarmDemoURL,
			chainId: ufarmDemoChainID,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		ufarmDemoDocker: {
			url: 'http://rpc-node:8545',
			chainId: ufarmDemoChainID,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		ufarm: {
			url: ufarmDevURL,
			chainId: ufarmDevChainID,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		ufarmLocal: {
			url: 'http://localhost:8545',
			chainId: ufarmDevChainID,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		ufarmDocker: {
			url: 'http://rpc-node:8545',
			chainId: ufarmDevChainID,
			tags: ['private', 'test'],
			...mnemonicAccounts,
		},
		mainnet: networkConfig(
			1,
			`https://mainnet.infura.io/v3/${infuraApiKey}`,
			process.env.ETHSCAN_API_KEY,
		),
		goerli: networkConfig(
			5,
			`https://goerli.infura.io/v3/${infuraApiKey}`,
			process.env.ETHSCAN_API_KEY,
		),
		arbitrum: {
			...networkConfig(
				42161,
				arbitrumRPCURL || `https://arbitrum-mainnet.infura.io/v3/${infuraApiKey}`,
				process.env.ARBISCAN_API_KEY,
			),
			tags: ['public', 'mainnet', 'arbitrum'],
		},
		sepolia: networkConfig(
			11155111,
			`https://arbitrum-sepolia.infura.io/v3/${infuraApiKey}`,
			process.env.ARBISCAN_API_KEY,
		),
		arbitrumGoerli: networkConfig(
			421613,
			`https://arbitrum-goerli.infura.io/v3/${infuraApiKey}`,
			process.env.ARBISCAN_API_KEY,
		),
		arbitrumSepolia: {
			...networkConfig(
				421614,
				`https://clean-orbital-violet.arbitrum-sepolia.quiknode.pro/${quicknodeApiKey}`,
				process.env.ARBISCAN_API_KEY,
			),
			live: true,
			saveDeployments: true,
			tags: ['public', 'test', 'arbitrumSepolia'],
		},
		optimism: networkConfig(
			10,
			`https://optimism-mainnet.infura.io/v3/${infuraApiKey}`,
			process.env.ETHSCAN_API_KEY,
		),
	},
	solidity: {
		compilers: [
			DEFAULT_COMPILER_SETTINGS_24,
			DEFAULT_COMPILER_SETTINGS_20,
			DEFAULT_COMPILER_SETTINGS_16,
			DEFAULT_COMPILER_SETTINGS_15,
			DEFAULT_COMPILER_SETTINGS_12,
			{
				version: '0.6.12',
				settings: {
					optimizer: {
						enabled: true,
						runs: 625,
					},
				},
			},
			{
				version: '0.6.6',
				settings: {
					optimizer: {
						enabled: true,
						runs: 625,
					},
				},
			},
			{
				version: '0.5.16',
				settings: {
					optimizer: {
						enabled: true,
						runs: 625,
					},
				},
			},
			{
				version: '0.4.24',
				settings: {
					optimizer: {
						enabled: true,
						runs: 200,
					},
				},
			},
		],
		overrides: {
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol':
				LOW_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/test/MockTimeNonfungiblePositionManager.sol':
				LOW_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/test/NFTDescriptorTest.sol':
				LOWEST_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/NonfungibleTokenPositionDescriptor.sol':
				LOWEST_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/libraries/NFTDescriptor.sol':
				LOWEST_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/test/UniswapV3/@uniswap/v3-periphery/contracts/libraries/NFTSVG.sol':
				LOWEST_OPTIMIZER_COMPILER_SETTINGS,
			'contracts/main/contracts/controllers/UnoswapV2Controller.sol':
				UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS,
			'contracts/test/ufarmLocal/controllers/UniswapV2ControllerUFarm.sol':
				UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS,
			'contracts/arbitrum/contracts/controllers/UniswapV2ControllerArbitrum.sol':
				UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS,
			'contracts/main/contracts/pool/PoolFactory.sol': {
				...UFARM_POOL_COMPILER_SETTINGS,
			},
			'contracts/main/contracts/pool/UFarmPool.sol': {
				...UFARM_POOL_COMPILER_SETTINGS,
			},
			'contracts/test/MockUFarmPool.sol': {
				...UFARM_POOL_COMPILER_SETTINGS,
			},
			'contracts/main/contracts/controllers/UnoswapV3Controller.sol': {
				...UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS,
			},
			'contracts/arbitrum/contracts/controllers/UniswapV3ControllerArbitrum.sol': {
				...UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS,
			},
			'contracts/test/ufarmLocal/controllers/UniswapV3ControllerUFarm.sol': {
				...UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS,
			},
		},
	},
	dependencyCompiler: {
		keep: true,
		paths: [
			'@chainlink/contracts/src/v0.8/tests/MockV3Aggregator.sol',
			'@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol',
		],
	},
	typechain: {
		target: 'ethers-v5',
		externalArtifacts: [],
	},
	namedAccounts: {
		deployer: {
			default: 0,
		},
		alice: 1,
		bob: 2,
		carol: 3,
		david: 4,
		emma: 5,
		frank: 6,
		grace: 7,
		henry: 8,
		isabella: 9,
		john: {
			default: '0x855fe5A6C6F3a769AFFabE37387AB7b023E90F07',
		},
		kaleb: {
			default: '0xf977814e90da44bfa03b6295a0616a897441acec',
		},
	},
	docgen: {
		path: './docs',
		clear: true,
		runOnCompile: false,
	},
	// like docgen, but for markdown
	markup: {
		outdir: './generated-markups',
		onlyFiles: [],
		skipFiles: ['./contracts/hardhat-dependency-compiler', '@uniswap', '@openzeppelin'],
		noCompile: false,
		verbose: false,
	},
	gasReporter: {
		enabled: false,
		noColors: true,
		excludeContracts: ['contracts/test/*/**.sol'],
	},
	mocha: {
		timeout: 100000000,
	},
}

declare module 'hardhat/types/runtime' {
	export interface HardhatRuntimeEnvironment {
		testnetDeployConfig: IDeployConfig
		deploymentsJsonPath: string
		mnemonic: string
		namedAddresses: {
			ufarmPanicManager: string
			ufarmFundApprover: string
			ufarmManager: string
			fundOwner: string
			ufarmOwner: string
		}
	}
}
extendEnvironment((hre) => {
	hre.testnetDeployConfig = require('./deploy-config.json')
	hre.deploymentsJsonPath = parsedDeploymentsJsonPath
	hre.mnemonic = parsedMnemonic
	hre.namedAddresses = {
		ufarmPanicManager,
		ufarmFundApprover,
		ufarmManager,
		fundOwner,
		ufarmOwner,
	}
})

export default config
