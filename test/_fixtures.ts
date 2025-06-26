// SPDX-License-Identifier: UNLICENSED

import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { ethers, upgrades, run } from 'hardhat'
import * as hre from 'hardhat'
import { BigNumberish, BigNumber, ContractTransaction, ContractReceipt, BaseContract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'

import {
	FundFactory__factory,
	UFarmFund,
	PriceOracle__factory,
	WETH9,
	PoolFactory__factory,
	AggregationRouterV5__factory,
	OneInchToUfarmTestEnv__factory,
	UniswapV2Factory,
	UniswapV2Router02,
	UFarmPool,
	UnoswapV2Controller,
	UFarmPool__factory,
	UFarmCore,
	UFarmCore__factory,
	PoolAdmin__factory,
	PriceOracle,
	IERC20Metadata,
	UniswapV2ControllerUFarm__factory,
	AggregatorV2V3Interface,
	UFarmFund__factory,
	UniswapV2Pair__factory,
	MockV3wstETHstETHAgg,
	StableCoin,
	DepositContractMock,
	NodeOperatorsRegistry,
	Lido,
	WstETH,
	AggregationRouterV5,
	UniswapV3Factory,
	SwapRouter,
	NonfungiblePositionManager,
	QuoterV2,
	PoolAdmin,
	PoolFactory,
	FundFactory,
	WstETHOracle,
	UnoswapV3Controller,
	OneInchV5Controller,
	QuexCore,
	QuexPool,
} from '../typechain-types'

import {
	constants,
	deployPool,
	encodePoolSwapDataUniswapV2,
	getReceipt,
	protocolToBytes32,
	getEventFromTx,
	AssetWithPriceFeed,
	addLiquidityUniswapV3,
	packPerformanceCommission,
	getInitCodeHash,
} from './_helpers'
import { _BNsqrt, bitsToBigNumber, PoolCreationStruct } from './_helpers'
import { _loadFixture, _tokensFixture } from './_deployed_fixtures'
import {
	getSignersByNames,
	getTokenDeployments,
	getInstanceFromDeployment,
	getInstanceOfDeployed,
	runDeployTag,
	mockedAggregatorName,
	getTokenFeed,
	isTestnet,
	getNetworkType,
} from '../scripts/_deploy_helpers'

export async function getPriceRate(
	tokenPriceOf: string,
	tokenPriceFrom: string,
	univ2_factory: UniswapV2Factory,
): Promise<BigNumber> {
	const pairAddr = await univ2_factory.getPair(tokenPriceOf, tokenPriceFrom)
	const pair = await ethers.getContractAt('UniswapV2Pair', pairAddr)

	const priceOf0 = tokenPriceOf == (await pair.token0())
	const [token0_addr, token1_addr] = [await pair.token0(), await pair.token1()]
	const [token0_instance, token1_instance] = [
		(await ethers.getContractAt(
			'@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
			token0_addr,
		)) as IERC20Metadata,
		(await ethers.getContractAt(
			'@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata',
			token1_addr,
		)) as IERC20Metadata,
	]
	const [token0_decimals, token1_decimals] = [
		await token0_instance.decimals(),
		await token1_instance.decimals(),
	]

	const reserves = await pair.getReserves()

	if (priceOf0) {
		return reserves[1]
			.mul(BigNumber.from(10).pow(token0_decimals).mul(997))
			.div(reserves[0].mul(1000))
	} else {
		return reserves[0]
			.mul(BigNumber.from(10).pow(token1_decimals).mul(997))
			.div(reserves[1].mul(1000))
	}
}

export async function executeAndGetTimestamp(tx: Promise<ContractTransaction>): Promise<BigNumber> {
	const receipt = await getReceipt(tx)
	const block = await ethers.provider.getBlock(receipt.blockNumber)
	return BigNumber.from(block.timestamp)
}

export async function _poolSwapUniV2(
	pool: UFarmPool,
	unoswapV2Controller: UnoswapV2Controller,
	amountIn: BigNumber,
	path: string[],
) {
	const amountOutMin = await unoswapV2Controller.getAmountOut(amountIn, path)
	const deadline = Date.now() + 100
	const tx = pool.protocolAction(
		constants.UFarm.prtocols.UniswapV2ProtocolString,
		encodePoolSwapDataUniswapV2(amountIn, amountOutMin, deadline, path),
	)
	// Find swap event:
	const event = await getEventFromTx(tx, unoswapV2Controller, 'SwapUnoV2')

	return {
		amountOut: event.args.amountOut as BigNumber,
		tx: tx,
	}
}

// FIXTURES

export async function blankPoolWithRatesFixture() {
	const {
		blankPool_instance,
		UFarmFund_instance,
		UFarmCore_instance,
		UniswapV2Router02_instance,
		bob,
		tokens,
		MockedAggregator_wstETHstETH,
		...rest
	} = await loadFixture(ETHPoolFixture)

	const performanceCommission = constants.Pool.Commission.ONE_HUNDRED_PERCENT / 10
	const packedPerformanceCommission = packPerformanceCommission([
		{ step: 0, commission: performanceCommission },
	])
	const managementCommission = constants.FIVE_PERCENTS
	const protocolCommission = constants.ZERO_POINT_3_PERCENTS

	await UFarmCore_instance.setProtocolCommission(protocolCommission)
	await blankPool_instance.admin.setCommissions(managementCommission, packedPerformanceCommission)

	const increaseWstETHRate = async (notUpdateOracle?: boolean) => {
		if (tokens.stETH) {
			await tokens.stETH['simulateBeaconRewards()']()

			if (notUpdateOracle) {
				return
			}
			await MockedAggregator_wstETHstETH.updateAnswerWithChainlinkPrice()
		}
	}

	return {
		blankPool_instance,
		UFarmFund_instance,
		UFarmCore_instance,
		UniswapV2Router02_instance,
		bob,
		tokens,
		performanceCommission,
		managementCommission,
		protocolCommission,
		MockedAggregator_wstETHstETH,
		increaseWstETHRate,
		...rest,
	}
}

export async function ETHPoolFixture() {
	const {
		UFarmCore_instance,
		alice,
		deployer,
		UFarmFund_instance,
		poolArgs,
		tokens,
		UnoswapV2Controller_instance,
		QuexCore_instance,
		...rest
	} = await loadFixture(fundWithPoolFixture)
	const ETHPoolArgs = poolArgs

	const ethPool_instance = await deployPool(ETHPoolArgs, UFarmFund_instance.connect(alice))

	// Pool init
	const MANAGERS_INVESTMENT = constants.ONE_HUNDRED_BUCKS

	await tokens.USDT.mint(UFarmFund_instance.address, MANAGERS_INVESTMENT)

	await UFarmFund_instance.approveAssetTo(
		tokens.USDT.address,
		ethPool_instance.pool.address,
		MANAGERS_INVESTMENT,
	)

	await UFarmFund_instance.depositToPool(ethPool_instance.pool.address, MANAGERS_INVESTMENT)
	await QuexCore_instance.sendResponse(ethPool_instance.pool.address, 0)
	await ethPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

	await _poolSwapUniV2(ethPool_instance.pool, UnoswapV2Controller_instance, MANAGERS_INVESTMENT, [
		tokens.USDT.address,
		tokens.WETH.address,
	])

	return {
		UFarmCore_instance,
		alice,
		deployer,
		UFarmFund_instance,
		poolArgs,
		tokens,
		ethPool_instance,
		ETHPoolArgs,
		MANAGERS_INVESTMENT,
		UnoswapV2Controller_instance,
		QuexCore_instance,
		...rest,
	}
}

export async function fundWithPoolFixture() {
	const {
		UFarmCore_instance,
		alice,
		deployer,
		UFarmFund_instance,
		poolArgs,
		tokens,
		emptyPoolArgs,
		...rest
	} = await loadFixture(UFarmFundFixture)

	await UFarmFund_instance.connect(alice).changeStatus(1)

	const UFarmPool_instance = await deployPool({ ...poolArgs }, UFarmFund_instance.connect(alice))

	await UFarmFund_instance.connect(alice).approveAssetTo(
		tokens.USDT.address,
		UFarmPool_instance.pool.address,
		ethers.constants.MaxUint256,
	)

	await UFarmPool_instance.admin.changePoolStatus(constants.Pool.State.Active)

	const blankPool_instance = await deployPool(
		{ ...emptyPoolArgs, name: 'Blank Pool' },
		UFarmFund_instance.connect(alice),
	)

	const initialized_pool_instance = await deployPool(
		{ ...poolArgs, name: 'Initialized Pool' },
		UFarmFund_instance.connect(alice),
	)

	await tokens.USDT.mint(UFarmFund_instance.address, constants.ONE_HUNDRED_BUCKS)

	// await initialized_pool_instance.whitelistProtocols([constants.UFarm.prtocols.UniswapV2ProtocolString])

	await UFarmFund_instance.approveAssetTo(
		tokens.USDT.address,
		initialized_pool_instance.pool.address,
		constants.ONE_HUNDRED_BUCKS,
	)

	await initialized_pool_instance.admin.changePoolStatus(constants.Pool.State.Active)

	return {
		...rest,
		alice,
		deployer,
		UFarmCore_instance,
		UFarmFund_instance,
		UFarmPool_instance,
		poolArgs,
		emptyPoolArgs,
		blankPool_instance,
		initialized_pool_instance,
		tokens,
	}
}

export async function UFarmFundFixture() {
	const { UFarmCore_instance, deployer, alice, bob, USDT, ...rest } = await loadFixture(
		UFarmCoreFixture,
	)

	const UnoswapV3Controller_instance = await getInstanceOfDeployed<UnoswapV3Controller>(
		hre,
		'UniV3Controller',
		deployer,
	)
	const OneInchController_instance = await getInstanceOfDeployed<OneInchV5Controller>(
		hre,
		'OneInchV5Controller',
		deployer,
	)
	await runDeployTag(hre, 'WhiteListTokens')

	const firstFundId = 0

	await UFarmCore_instance.connect(deployer).createFund(
		alice.address,
		protocolToBytes32('AnyValue'),
	)

	const address_UFarmFund = await UFarmCore_instance.getFund(firstFundId)

	const UFarmFund_instance: UFarmFund = await ethers.getContractAt(
		'UFarmFund',
		address_UFarmFund,
		alice,
	)

	const tx = {
		to: UFarmFund_instance.address,
		value: ethers.utils.parseEther("1.0"),
	};
	  
	const txResponse = await alice.sendTransaction(tx);
	await txResponse.wait();

	const allPoolPermissionsMask = bitsToBigNumber(
		Array.from(Object.values(constants.Pool.Permissions)),
	)

	const poolArgs: PoolCreationStruct = {
		minInvestment: 1 as BigNumberish,
		maxInvestment: ethers.utils.parseUnits('1000000', 6),
		managementCommission: 2 as BigNumberish,
		packedPerformanceCommission: packPerformanceCommission([{ step: 0, commission: 3 }]),
		withdrawalLockupPeriod: 0 as BigNumberish,
		valueToken: USDT.address,
		staff: [
			{
				addr: bob.address,
				permissionsMask: bitsToBigNumber([
					constants.Pool.Permissions.Member,
					constants.Pool.Permissions.UpdateLockupPeriods,
				]),
			},
			{
				addr: alice.address,
				permissionsMask: bitsToBigNumber(Array.from(Object.values(constants.Pool.Permissions))),
			},
		],
		name: 'UFarmPool',
		symbol: 'Pool symbol',
	}

	const emptyPoolArgs: PoolCreationStruct = {
		minInvestment: 0 as BigNumberish,
		maxInvestment: ethers.constants.MaxUint256 as BigNumberish,
		managementCommission: 0 as BigNumberish,
		packedPerformanceCommission: 0 as BigNumberish,
		withdrawalLockupPeriod: 0 as BigNumberish,
		valueToken: USDT.address,
		staff: [],
		name: 'Pool name',
		symbol: 'Pool symbol',
	}

	return {
		...rest,
		alice,
		bob,
		deployer,
		UFarmCore_instance,
		UFarmFund_instance,
		poolArgs,
		emptyPoolArgs,
		USDT,
		UnoswapV3Controller_instance,
		OneInchController_instance,
	}
}

export async function UFarmCoreFixture() {
	const { deployer, PriceOracle_instance, tokens, UnoswapV2Controller_instance, ...rest } =
		await loadFixture(UniswapV3Fixture)

	const Pool_implementation_factory = (await ethers.getContractFactory(
		'UFarmPool',
	)) as UFarmPool__factory

	const PoolAdmin_implementation_factory = (await ethers.getContractFactory(
		'PoolAdmin',
	)) as PoolAdmin__factory

	const Fund_implementation_factory = (await ethers.getContractFactory(
		'UFarmFund',
	)) as UFarmFund__factory

	const Core_implementation_factory = (await ethers.getContractFactory(
		'UFarmCore',
	)) as UFarmCore__factory

	await runDeployTag(hre, 'InitializeUFarm')
	await runDeployTag(hre, 'WhitelistControllers')

	const Pool_beacon = await getInstanceOfDeployed<UFarmPool>(hre, 'UFarmPool', deployer)

	const PoolAdmin_beacon = await getInstanceOfDeployed<PoolAdmin>(hre, 'PoolAdmin', deployer)
	const Fund_beacon = await getInstanceOfDeployed<UFarmFund>(hre, 'UFarmFund', deployer)

	const UFarmCore_instance = await getInstanceOfDeployed<UFarmCore>(hre, 'UFarmCore', deployer)
	const PoolFactory_factory = (await ethers.getContractFactory(
		'PoolFactory',
	)) as PoolFactory__factory

	const PoolFactory_instance = await getInstanceOfDeployed<PoolFactory>(
		hre,
		'PoolFactory',
		deployer,
	)

	const FundFactory_factory = (await ethers.getContractFactory(
		'FundFactory',
	)) as FundFactory__factory
	const FundFactory_instance = await getInstanceOfDeployed<FundFactory>(
		hre,
		'FundFactory',
		deployer,
	)

	const factories = {
		PoolFactory_factory,
		FundFactory_factory,
	}

	return {
		Pool_beacon,
		PoolAdmin_beacon,
		Fund_beacon,
		deployer,
		UFarmCore_instance,
		Pool_implementation_factory,
		Core_implementation_factory,
		PriceOracle_instance,
		UnoswapV2Controller_instance,
		FundFactory_instance,
		PoolFactory_instance,
		factories,
		tokens,
		...rest,
	}
}

export async function UniswapV3Fixture() {
	const { deployer, wallet, tokens, PriceOracle_instance, ...rest } = await loadFixture(
		OneInchFixture,
	)
	await runDeployTag(hre, 'UniV3Pairs')

	const uniswapV3Factory_instance = await getInstanceOfDeployed<UniswapV3Factory>(
		hre,
		'UniswapV3Factory',
	)

	const uniswapv3Router_instance = await getInstanceOfDeployed<SwapRouter>(hre, 'SwapRouter')

	const nonFungPosManager_instance = await getInstanceOfDeployed<NonfungiblePositionManager>(
		hre,
		'NonfungiblePositionManager',
	)

	const quoter_instance = await getInstanceOfDeployed<QuoterV2>(hre, 'QuoterV2')

	return {
		deployer,
		wallet,
		tokens,
		uniswapV3Factory_instance,
		uniswapv3Router_instance,
		quoter_instance,
		PriceOracle_instance,
		nonFungPosManager_instance,
		...rest,
	}
}

export async function OneInchFixture() {
	const { deployer, tokens, ...rest } = await loadFixture(PriceOracleFixture)

	await runDeployTag(hre, 'OneInch')

	const oneInchAggrV5_factory = (await ethers.getContractFactory(
		'AggregationRouterV5',
	)) as AggregationRouterV5__factory

	const oneInchAggrV5_instance = await getInstanceOfDeployed<AggregationRouterV5>(
		hre,
		'AggregationRouterV5',
	)

	const inchConverter_factory = (await ethers.getContractFactory(
		'OneInchToUfarmTestEnv',
	)) as OneInchToUfarmTestEnv__factory

	const inchConverter_instance = await inchConverter_factory.deploy(tokens.WETH.address)

	return {
		oneInchAggrV5_instance,
		oneInchAggrV5_factory,
		inchConverter_instance,
		deployer,
		tokens,
		...rest,
	}
}

export async function PriceOracleFixture() {
	const { deployer, tokens, ...rest } = await loadFixture(MockedAggregatorFixture)

	await runDeployTag(hre, 'QuexCore')
	const QuexCore_instance = (await getInstanceOfDeployed<QuexCore>(hre, 'QuexCore')).connect(deployer)
	
	await runDeployTag(hre, 'QuexPool')
	const QuexPool_instance = (await getInstanceOfDeployed<QuexPool>(hre, 'QuexPool')).connect(deployer)

	await runDeployTag(hre, 'PriceOracle')
	const PriceOracle_factory = (await ethers.getContractFactory(
		'PriceOracle',
	)) as PriceOracle__factory

	const PriceOracle_instance = await getInstanceOfDeployed<PriceOracle>(hre, 'PriceOracle')

	const UnoswapV2Controller_factory = (await ethers.getContractFactory(
		'UniswapV2ControllerUFarm',
	)) as UniswapV2ControllerUFarm__factory

	const UnoswapV2Controller_instance = await UnoswapV2Controller_factory.deploy(
		rest.UniswapV2Factory_instance.address,
		rest.UniswapV2Router02_instance.address,
		PriceOracle_instance.address,
		getInitCodeHash(UniswapV2Pair__factory.bytecode),
	)
	await UnoswapV2Controller_instance.deployed()

	return {
		deployer,
		tokens,
		PriceOracle_instance,
		PriceOracle_factory,
		UnoswapV2Controller_instance,
		QuexCore_instance,
		QuexPool_instance,
		...rest,
	}
}

export async function MockedAggregatorFixture() {
	const { tokens, deployer, allTokenDeployments, ...rest } = await loadFixture(UniswapFixture)

	await runDeployTag(hre, 'MockedAggregators')

	const tokenFeeds: Array<AssetWithPriceFeed> = []

	const MockedAggregator_wstETHstETH = await getInstanceOfDeployed<MockV3wstETHstETHAgg>(
		hre,
		'LidoRateOracle',
		deployer,
	)

	await runDeployTag(hre, 'WstETHOracle')
	const WstETHOracle = await getInstanceOfDeployed<WstETHOracle>(hre, 'WSTETHOracle', deployer)

	const WETH_feed = await getTokenFeed(hre, 'WETH')
	tokenFeeds.push(WETH_feed)
	console.log('WETH_feed', WETH_feed)

	if (hre.network.tags['arbitrum']) {
	} else {
		const stETH_feed = await getTokenFeed(hre, 'STETH')
		tokenFeeds.push(stETH_feed)
		console.log('stETH_feed', stETH_feed)
	}

	const WstETH_feed = await getTokenFeed(hre, 'WSTETH')
	tokenFeeds.push(WstETH_feed)
	console.log('WstETH_feed', WstETH_feed)

	const DAI_feed = await getTokenFeed(hre, 'DAI')
	tokenFeeds.push(DAI_feed)

	const USDC_feed = await getTokenFeed(hre, 'USDC')
	tokenFeeds.push(USDC_feed)

	const USDT_feed = await getTokenFeed(hre, 'USDT')
	tokenFeeds.push(USDT_feed)

	const feedInstancesTokenToUSDT = {
		WETH: await getInstanceOfDeployed<AggregatorV2V3Interface>(
			hre,
			mockedAggregatorName('WETH', hre.network),
		),
		DAI: await getInstanceOfDeployed<AggregatorV2V3Interface>(
			hre,
			mockedAggregatorName('DAI', hre.network),
		),
		USDC: await getInstanceOfDeployed<AggregatorV2V3Interface>(
			hre,
			mockedAggregatorName('USDC', hre.network),
		),
		USDT: await getInstanceOfDeployed<AggregatorV2V3Interface>(
			hre,
			mockedAggregatorName('USDT', hre.network),
		),
		stETH: hre.network.tags['arbitrum']
			? null
			: await getInstanceOfDeployed<AggregatorV2V3Interface>(
					hre,
					mockedAggregatorName('stETH', hre.network),
			  ),
		WstETH: WstETHOracle,
	}

	return {
		feedInstancesTokenToUSDT,
		MockedAggregator_wstETHstETH,
		tokens,
		tokenFeeds,
		deployer,
		...rest,
	}
}

export async function UniswapFixture() {
	const { deployer, ...rest } = await loadFixture(lidoFixture)

	await runDeployTag(hre, 'UniV2Pairs')

	const UniswapV2Factory_instance = await getInstanceOfDeployed<UniswapV2Factory>(
		hre,
		'UniswapV2Factory',
		deployer,
	)

	const UniswapV2Router02_instance = await getInstanceOfDeployed<UniswapV2Router02>(
		hre,
		'UniswapV2Router02',
		deployer,
	)

	return {
		deployer,
		UniswapV2Factory_instance,
		UniswapV2Router02_instance,
		...rest,
	}
}

export async function lidoFixture() {
	const { deployer, wallet, tokens, ...rest } = await loadFixture(tokensFixture)

	const wsteth_instance = await getInstanceOfDeployed<WstETH>(hre, 'WSTETH', deployer)

	const getWstETHstETHRate = async () => {
		return await wsteth_instance.stEthPerToken()
	}

	if (isTestnet(hre.network)) {
		const lido_deposit_contract_instance = await getInstanceOfDeployed<DepositContractMock>(
			hre,
			'DepositContractMock',
			deployer,
		)
		const lido_registry_instance = await getInstanceOfDeployed<NodeOperatorsRegistry>(
			hre,
			'NodeOperatorsRegistry',
			deployer,
		)

		const lido_instance = await getInstanceOfDeployed<Lido>(hre, 'STETH', deployer)

		const testMint = await lido_instance.submit(ethers.constants.AddressZero, {
			value: ethers.utils.parseEther('1000000'),
		})

		return {
			deployer,
			wallet,
			tokens: {
				...tokens,
				WstETH: wsteth_instance,
				stETH: lido_instance,
			},
			...rest,
			getWstETHstETHRate,
			lido_instance,
			wsteth_instance,
			lido_registry_instance,
			lido_deposit_contract_instance,
		}
	}
	return {
		deployer,
		wallet,
		tokens: {
			...tokens,
			WstETH: wsteth_instance,
			stETH: null,
		},
		...rest,
		getWstETHstETHRate,
		lido_instance: null,
		wsteth_instance,
		lido_registry_instance: null,
		lido_deposit_contract_instance: null,
	}
}

export async function tokensFixture() {
	if (isTestnet(hre.network)) {
		await runDeployTag(hre, 'Tokens')
	} else {
		switch (getNetworkType(hre.network)) {
			case 'arbitrum':
				await runDeployTag(hre, 'PrepareEnvARB')
				break
		}
	}

	const [deployer, alice, bob, carol, wallet] = await getSignersByNames(hre, [
		'deployer',
		'alice',
		'bob',
		'carol',
		'david',
	])

	// deployer

	const allTokenDeployments = await getTokenDeployments(hre)

	const tokens = {
		DAI: getInstanceFromDeployment<StableCoin>(hre, allTokenDeployments['DAI'], deployer),
		USDC: getInstanceFromDeployment<StableCoin>(hre, allTokenDeployments['USDC'], deployer),
		USDT: getInstanceFromDeployment<StableCoin>(hre, allTokenDeployments['USDT'], deployer),
		WETH: getInstanceFromDeployment<WETH9>(hre, allTokenDeployments['WETH'], deployer),
	}

	const tokensAddresses = Object.values(tokens).map((token) => token.address)

	return {
		deployer,
		alice,
		bob,
		carol,
		wallet,
		DAI: tokens.DAI,
		USDC: tokens.USDC,
		USDT: tokens.USDT,
		WETH: tokens.WETH,
		tokens,
		tokensAddresses,
		allTokenDeployments,
	}
}

export { addLiquidityUniswapV3 }
