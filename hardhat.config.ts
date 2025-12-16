import * as dotenv from 'dotenv'
import { HardhatUserConfig, extendEnvironment } from 'hardhat/config'
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
import {
    LOW_OPTIMIZER_COMPILER_SETTINGS,
    LOWEST_OPTIMIZER_COMPILER_SETTINGS,
    DEFAULT_COMPILER_SETTINGS_16,
    DEFAULT_COMPILER_SETTINGS_20,
    DEFAULT_COMPILER_SETTINGS_24,
    DEFAULT_COMPILER_SETTINGS_15,
    DEFAULT_COMPILER_SETTINGS_12,
    UFARM_POOL_COMPILER_SETTINGS,
    UFARM_UNOSWAPV3_CONTROLLER_COMPILER_SETTINGS,
    UNOSWAP_V2_CONTROLLER_COMPILER_SETTINGS,
    QUEX_CORE_COMPILER_SETTINGS
} from './scripts/_compile_options';

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

const infuraApiKey: string = process.env.INFURA_API_KEY || ''
const quicknodeApiKey: string = process.env.QUICKNODE_API_KEY || ''
const arbitrumRPCURL: string = process.env.ARBITRUM_RPC_URL || ''
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
			apiUrl: verifyKey ? process.env.ETHERSCAN_VERIFY_URL : undefined,
		},
	},
})

const config: HardhatUserConfig = {
	networks: {
		hardhat: {
			...mnemonicAccounts,
			allowUnlimitedContractSize: false,
			saveDeployments: true,
			forking: {
				url: `https://arbitrum-mainnet.infura.io/v3/${infuraApiKey}`,
				enabled: false,
			},
			autoImpersonate: true,
			tags: ['private', 'test'],
		},
		localhost: {
			...networkConfig(31337, null),
			allowUnlimitedContractSize: false,
			saveDeployments: true,
			tags: ['private', 'test'],
		},
		ufarmDemo: {
			...networkConfig(ufarmDemoChainID, ufarmDemoURL),
			tags: ['private', 'test'],
		},
		ufarmDemoDocker: {
			...networkConfig(ufarmDemoChainID, 'http://rpc-node:8545'),
			tags: ['private', 'test'],
		},
		ufarm: {
			...networkConfig(ufarmDevChainID, ufarmDevURL),
			tags: ['private', 'test'],
		},
		ufarmLocal: {
			...networkConfig(ufarmDevChainID, 'http://localhost:8545'),
			tags: ['private', 'test'],
		},
		ufarmDocker: {
			...networkConfig(ufarmDevChainID, 'http://rpc-node:8545'),
			tags: ['private', 'test'],
		},
		mainnet: {
			...networkConfig(
				1,
				`https://mainnet.infura.io/v3/${infuraApiKey}`,
				process.env.ETHSCAN_API_KEY,
			),
			tags: ['public', 'mainnet', 'ethereum'],
		},
		goerli: networkConfig(
			5,
			`https://goerli.infura.io/v3/${infuraApiKey}`,
		),
		arbitrum: {
			...networkConfig(
				42161,
				arbitrumRPCURL || `https://arbitrum-mainnet.infura.io/v3/${infuraApiKey}`,
				process.env.ETHSCAN_API_KEY,
			),
			tags: ['public', 'mainnet', 'arbitrum'],
		},
		sepolia: networkConfig(
			11155111,
			`https://arbitrum-sepolia.infura.io/v3/${infuraApiKey}`,
		),
		arbitrumGoerli: networkConfig(
			421613,
			`https://arbitrum-goerli.infura.io/v3/${infuraApiKey}`,
		),
		arbitrumSepolia: {
			...networkConfig(
				421614,
				`https://clean-orbital-violet.arbitrum-sepolia.quiknode.pro/${quicknodeApiKey}`,
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
			'contracts/main/contracts/controllers/ArbitraryController/Guard2.sol': {
				...UFARM_POOL_COMPILER_SETTINGS,
			},
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
			'contracts/test/Quex/QuexCore.sol': {
				...QUEX_CORE_COMPILER_SETTINGS,
			},
			'contracts/test/Quex/QuexPool.sol': {
				...QUEX_CORE_COMPILER_SETTINGS,
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
