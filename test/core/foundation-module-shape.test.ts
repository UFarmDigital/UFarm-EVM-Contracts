import { expect } from "chai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { network } from "hardhat";
import FoundationCoreConfigModule from "../../ignition/modules/FoundationCoreConfig.js";
import FoundationAdaptersModule from "../../ignition/modules/FoundationAdapters.js";
import FoundationModule from "../../ignition/modules/Foundation.js";
import FoundationTimelockModule from "../../ignition/modules/FoundationTimelock.js";
import PrivateSetupModule from "../../ignition/modules/PrivateSetup.js";
import { resolveIgnitionParameters } from "../../scripts/helpers/deploy-helpers.js";

const { ethers } = await network.create();

describe("Foundation Ignition module", function () {
  it("exports the Foundation module", async function () {
    expect(FoundationModule.id).to.equal("Foundation");
  });

  it("includes immutable factory initialization without timelock handoff futures", async function () {
    const futureIds = Array.from(FoundationModule.futures, (future) => future.id);

    expect(futureIds).to.include.members(["Foundation#InitializeFactory", "Foundation#InitializeCrossChain"]);
    expect(futureIds).to.not.include.members([
      "Foundation#TimelockController",
      "Foundation#EscrowBeacon",
      "Foundation#TransferCuratorBeaconOwnership",
      "Foundation#TransferVaultBeaconOwnership",
      "Foundation#TransferEscrowBeaconOwnership",
      "Foundation#GrantTimelockFullPermissions",
      "Foundation#RevokeDeployerOwnerPermission",
    ]);
  });

  it("deploys real curator vault and escrow implementations", async function () {
    const futureIds = Array.from(FoundationModule.futures, (future) => future.id);
    const source = await fs.readFile("ignition/modules/Foundation.ts", "utf8");

    expect(Object.keys(FoundationModule.results)).to.have.members([
      "core",
      "escrow",
      "quexOracle",
      "quexBatchOracle",
      "curatorBeacon",
      "vaultBeacon",
    ]);
    expect(futureIds).to.include.members([
      "Foundation#UFarmCoreImpl",
      "Foundation#UFarmCoreProxy",
      "Foundation#UFarmCore",
      "Foundation#UFarmCuratorImpl",
      "Foundation#UFarmVaultImpl",
      "Foundation#UFarmEscrowImpl",
      "Foundation#UFarmEscrowProxy",
      "Foundation#UFarmEscrow",
      "Foundation#UFarmQuexOracleImpl",
      "Foundation#UFarmQuexOracleProxy",
      "Foundation#UFarmQuexOracle",
      "Foundation#UFarmQuexBatchOracleImpl",
      "Foundation#UFarmQuexBatchOracleProxy",
      "Foundation#UFarmQuexBatchOracle",
      "Foundation#UFarmCuratorBeacon",
      "Foundation#UFarmVaultBeacon",
    ]);
    expect(futureIds).to.not.include.members([
      "Foundation#Core",
      "Foundation#Escrow",
      "Foundation#UFarmCurator",
      "Foundation#UFarmVault",
      "Foundation#CuratorBeacon",
      "Foundation#VaultBeacon",
    ]);
    expect(Object.keys(FoundationModule.results)).to.not.include.members([
      "coreImplementation",
      "coreProxy",
      "escrowImplementation",
      "escrowProxy",
      "quexOracleImplementation",
      "quexOracleProxy",
    ]);
    expect(source).to.include('m.contract("UFarmCurator"');
    expect(source).to.include('m.contract("UFarmVault"');
    expect(source).to.include('m.contract("UFarmEscrow"');
    expect(source).to.include('m.contract("UFarmQuexOracle"');
    expect(source).to.include('m.contract("UFarmQuexBatchOracle"');
    expect(source).to.include('m.contract("UFarmCore", [], { id: "UFarmCoreImpl", after: [create3Helper] })');
    expect(source).to.include("after: [deployCoreProxy]");
    expect(source).to.include('m.contractAt("UFarmQuexOracle"');
    expect(source).to.include("0x97076a3c0A414E779f7BEC2Bd196D4FdaADFDB96");
    expect(source).to.include('m.getParameter("quexSubscriptionId")');
    expect(source).to.not.include('m.getParameter("quexSubscriptionId", 1n)');
    expect(source).to.include('m.getParameter("quexBatchOraclePool")');
    expect(source).to.include('m.getParameter("quexBatchGasLimit", 1_000_000n)');
    expect(source).to.include('m.contract("ERC1967Proxy"');
    expect(source).to.not.include('"EscrowBeacon"');
    expect(source).to.include('"initialize"');
    expect(source).to.include('"initializeFactory"');
    expect(source).to.not.include('"configureFactory"');
    expect(source).to.not.include('"setFactoryBeacon"');
  });

  it("serializes Foundation transaction-bearing futures for public RPC nonce handling", function () {
    const futures = new Map(Array.from(FoundationModule.futures, (future) => [future.id, future]));
    const transactionFutureIds = Array.from(FoundationModule.futures)
      .filter((future) => future.type.includes("CONTRACT_DEPLOYMENT") || future.type === "CONTRACT_CALL")
      .map((future) => future.id);

    expect(transactionFutureIds).to.have.members([
      "Foundation#FoundationCreate3Helper",
      "Foundation#UFarmCoreImpl",
      "Foundation#DeployUFarmCoreProxyCreate3",
      "Foundation#UFarmCuratorImpl",
      "Foundation#UFarmVaultImpl",
      "Foundation#VaultAdapterGatewayModule",
      "Foundation#VaultAdminConfigModule",
      "Foundation#VaultLifecycleModule",
      "Foundation#UFarmEscrowImpl",
      "Foundation#UFarmQuexOracleImpl",
      "Foundation#UFarmQuexOracleProxy",
      "Foundation#UFarmQuexBatchOracleImpl",
      "Foundation#UFarmQuexBatchOracleProxy",
      "Foundation#UFarmEscrowProxy",
      "Foundation#UFarmCuratorBeacon",
      "Foundation#UFarmVaultBeacon",
      "Foundation#InitializeFactory",
      "Foundation#InitializeCrossChain",
      "Foundation#SetAdapterGatewayModule",
      "Foundation#SetAdminConfigModule",
      "Foundation#SetLifecycleModule",
    ]);

    const expectedDependencies = new Map([
      ["Foundation#UFarmCoreImpl", "Foundation#FoundationCreate3Helper"],
      ["Foundation#DeployUFarmCoreProxyCreate3", "Foundation#UFarmCoreImpl"],
      ["Foundation#UFarmCuratorImpl", "Foundation#UFarmCoreProxyAddress"],
      ["Foundation#UFarmVaultImpl", "Foundation#UFarmCuratorImpl"],
      ["Foundation#VaultAdapterGatewayModule", "Foundation#UFarmVaultImpl"],
      ["Foundation#VaultAdminConfigModule", "Foundation#VaultAdapterGatewayModule"],
      ["Foundation#VaultLifecycleModule", "Foundation#VaultAdminConfigModule"],
      ["Foundation#UFarmQuexOracleImpl", "Foundation#VaultLifecycleModule"],
      ["Foundation#UFarmQuexOracleProxy", "Foundation#UFarmQuexOracleImpl"],
      ["Foundation#UFarmQuexBatchOracleImpl", "Foundation#UFarmQuexOracleProxy"],
      ["Foundation#UFarmQuexBatchOracleProxy", "Foundation#UFarmQuexBatchOracleImpl"],
      ["Foundation#UFarmEscrowImpl", "Foundation#UFarmQuexBatchOracleProxy"],
      ["Foundation#UFarmEscrowProxy", "Foundation#UFarmEscrowImpl"],
      ["Foundation#UFarmCuratorBeacon", "Foundation#UFarmEscrowProxy"],
      ["Foundation#UFarmVaultBeacon", "Foundation#UFarmCuratorBeacon"],
      ["Foundation#InitializeFactory", "Foundation#UFarmVaultBeacon"],
      ["Foundation#InitializeCrossChain", "Foundation#InitializeFactory"],
      ["Foundation#SetAdapterGatewayModule", "Foundation#InitializeCrossChain"],
      ["Foundation#SetAdminConfigModule", "Foundation#SetAdapterGatewayModule"],
      ["Foundation#SetLifecycleModule", "Foundation#SetAdminConfigModule"],
    ]);

    for (const [futureId, dependencyId] of expectedDependencies) {
      const future = futures.get(futureId);
      expect(future, futureId).to.not.equal(undefined);
      expect(Array.from(future!.dependencies, (dependency) => dependency.id)).to.include(dependencyId);
    }
  });

  it("matches the real CreateX CREATE3 address vector", async function () {
    const helper = await ethers.deployContract("FoundationCreate3Helper");

    expect(
      await helper.create3Address(
        "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed",
        "0x52388497633a31dc8be827950cf968be94d80e9c",
        "0x52388497633a31dc8be827950cf968be94d80e9c0007c98367ca7a4ef177c9d3",
      ),
    ).to.equal("0x633C2D2a08C8C54f67d7d22485dB470a87C4964c");
  });

  it("builds npm artifacts needed by the Foundation module", async function () {
    const source = await fs.readFile("hardhat.config.ts", "utf8");

    expect(source).to.include("@openzeppelin/contracts/governance/TimelockController.sol");
  });

  it("uses the default Ignition sender for transaction calls", async function () {
    const modulePaths = [
      "ignition/modules/Foundation.ts",
      "ignition/modules/FoundationAdapters.ts",
      "ignition/modules/FoundationCoreConfig.ts",
      "ignition/modules/FoundationTimelock.ts",
      "ignition/modules/PrivateSetup.ts",
    ];

    for (const modulePath of modulePaths) {
      const source = await fs.readFile(modulePath, "utf8");
      expect(source, modulePath).to.not.include("from: deployer");
    }
  });

  it("defaults the Foundation timelock delay to seven days", async function () {
    const source = await fs.readFile("ignition/modules/FoundationTimelock.ts", "utf8");

    expect(source).to.include('m.getParameter("timelockMinDelay", 7n * 24n * 60n * 60n)');
  });

  it("uses explicit parameter loading in deploy scripts and chain id validation in hardhat config", async function () {
    const foundationScript = await fs.readFile("scripts/deploy-foundation.ts", "utf8");
    const upgradeScript = await fs.readFile("scripts/upgrade-foundation.ts", "utf8");
    const testSetupScript = await fs.readFile("scripts/deploy-private-setup.ts", "utf8");
    const helperScript = await fs.readFile("scripts/helpers/deploy-helpers.ts", "utf8");
    const packageJson = await fs.readFile("package.json", "utf8");
    const hardhatConfig = await fs.readFile("hardhat.config.ts", "utf8");
    const parameterSample = await fs.readFile("ignition/parameters.sample.json", "utf8");

    expect(foundationScript).to.include("--no-parameters");
    expect(foundationScript).to.include("--parameters");
    expect(foundationScript).to.include("--dry-run");
    expect(foundationScript).to.include("--deployment-id");
    expect(foundationScript).to.include("--logical-salt");
    expect(foundationScript).to.include("--foundation");
    expect(foundationScript).to.include("--timelock");
    expect(foundationScript).to.include("--adapters");
    expect(foundationScript).to.include("if (deployFoundation)");
    expect(upgradeScript).to.include("--include");
    expect(upgradeScript).to.include("parseUpgradeTargets");
    expect(upgradeScript).to.include("oracleForVault(ZeroAddress)");
    expect(upgradeScript).to.include("upgradeToAndCall");
    expect(upgradeScript).to.include("upgradeTo");
    expect(foundationScript).to.include("FoundationAdaptersModule");
    expect(foundationScript).to.include("FoundationTimelockModule");
    expect(foundationScript).to.include("./helpers/deploy-helpers.js");
    expect(foundationScript).to.include("requireUFarmChainId");
    expect(foundationScript).to.include('network.create("ufarm")');
    expect(foundationScript).to.include("resolveIgnitionParameters");
    expect(hardhatConfig).to.not.include('import hre from "hardhat"');
    expect(hardhatConfig).to.not.include("if (network &&");
    expect(hardhatConfig).to.not.include("console.log");
    expect(hardhatConfig).to.include("ETHERSCAN_API_KEY");
    expect(hardhatConfig).to.include("blockscout");
    expect(hardhatConfig).to.include("sourcify");
    expect(testSetupScript).to.include("--dry-run");
    expect(testSetupScript).to.include("--private-setup-deployment-id");
    expect(testSetupScript).to.include("--foundation-deployment-id");
    expect(testSetupScript).to.include("--parameters");
    expect(testSetupScript).to.include("FoundationCoreConfigModule");
    expect(testSetupScript).to.include("FoundationAdaptersModule");
    expect(testSetupScript).to.include("ignition.deploy(FoundationCoreConfigModule");
    expect(testSetupScript).to.include("ignition.deploy(FoundationAdaptersModule");
    expect(testSetupScript).to.include("PrivateSetup#QuexCore");
    expect(testSetupScript).to.include("PrivateSetup#CCIPRouter");
    expect(testSetupScript).to.include("quexCore: quexCoreAddress");
    expect(testSetupScript).to.include("crossChainRouter: ccipRouterAddress");
    expect(testSetupScript).to.include("crossChainFeeToken: valueTokenAddress");
    expect(testSetupScript).to.include("crossChainToken: valueTokenAddress");
    expect(testSetupScript).to.include("valueTokenAddress");
    expect(testSetupScript).to.include("valueTokenPriceFeedAddress");
    expect(testSetupScript).to.include("quexOracle");
    expect(testSetupScript).to.include("./helpers/deploy-helpers.js");
    expect(testSetupScript).to.include("requireUFarmChainId");
    expect(testSetupScript).to.include("readIgnitionDeployedAddress");
    expect(testSetupScript).to.include("getCode");
    expect(testSetupScript).to.include("skipping PrivateSetup deployment");
    expect(testSetupScript).to.include('network.create("ufarm")');
    expect(packageJson).to.include("node --import tsx scripts/deploy-private-setup.ts");
    expect(packageJson).to.include("verify:ignition");
    expect(packageJson).to.include("hardhat --network ufarm ignition verify");
    expect(packageJson).to.include("upgrade:foundation");
    expect(packageJson).to.include("node --import tsx scripts/upgrade-foundation.ts");
    expect(packageJson).to.include("exec:any:call");
    expect(packageJson).to.include("node --import tsx scripts/exec-any-call.ts");
    expect(packageJson).to.include("exec:any:permission");
    expect(packageJson).to.include("node --import tsx scripts/exec-any-permission.ts");
    expect(packageJson).to.include("exec:ccip:router");
    expect(packageJson).to.include("node --import tsx scripts/exec-ccip-router.ts");
    expect(packageJson).to.include("exec:core:ccip");
    expect(packageJson).to.include("node --import tsx scripts/exec-core-ccip.ts");
    expect(packageJson).to.include("exec:vault:ccip");
    expect(packageJson).to.include("node --import tsx scripts/exec-vault-ccip.ts");
    expect(helperScript).to.include("buildCreateXSalt");
    expect(helperScript).to.include("resolveIgnitionParameters");
    expect(helperScript).to.include("argumentValue");
    expect(helperScript).to.include("requireUFarmChainId");
    expect(helperScript).to.include("UFARM_CHAIN_ID is required");
    expect(helperScript).to.include("readIgnitionDeployedAddress");
    expect(parameterSample).to.include("valueTokenPriceFeed");
    expect(parameterSample).to.include("valueTokenMaxPriceAge");
    expect(parameterSample).to.include("valueTokenMinPrice");
    expect(parameterSample).to.include("valueTokenMaxPrice");
  });

  it("loads ignition parameters only from files", async function () {
    const parametersPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ufarm-params-")), "params.json");
    await fs.writeFile(parametersPath, JSON.stringify({ Foundation: { accountingChainId: 31337 } }));

    expect(resolveIgnitionParameters(parametersPath).parameters.Foundation.accountingChainId).to.equal(31337);
    expect(() => resolveIgnitionParameters('{"Foundation":{"accountingChainId":31337}}')).to.throw(
      "Ignition parameters file not found",
    );
  });

  it("exposes a generic permission lookup exec script", async function () {
    const script = await fs.readFile("scripts/exec-any-permission.ts", "utf8");
    const packageJson = await fs.readFile("package.json", "utf8");

    expect(packageJson).to.include("exec:any:permission");
    expect(script).to.include("--contract");
    expect(script).to.include("--account");
    expect(script).to.include("permissionMask");
  });
});

describe("Foundation Timelock Ignition module", function () {
  it("exports the timelock handoff module", async function () {
    expect(FoundationTimelockModule.id).to.equal("FoundationTimelock");
  });

  it("owns timelock deployment and handoff futures", async function () {
    const futureIds = Array.from(FoundationTimelockModule.futures, (future) => future.id);

    expect(futureIds).to.include.members([
      "FoundationTimelock#TimelockController",
      "FoundationTimelock#TransferCuratorBeaconOwnership",
      "FoundationTimelock#TransferVaultBeaconOwnership",
      "FoundationTimelock#GrantTimelockFullPermissions",
      "FoundationTimelock#RevokeDeployerOwnerPermission",
    ]);
    expect(futureIds).to.not.include("FoundationTimelock#TransferEscrowBeaconOwnership");
  });
});

describe("PrivateSetup Ignition module", function () {
  it("exports the PrivateSetup module", async function () {
    expect(PrivateSetupModule.id).to.equal("PrivateSetup");
  });

  it("deploys the local CreateX-compatible test double, mock price feed, and mints private-chain USDC", async function () {
    const futureIds = Array.from(PrivateSetupModule.futures, (future) => future.id);
    expect(futureIds).to.include.members([
      "PrivateSetup#CreateX",
      "PrivateSetup#QuexCore",
      "PrivateSetup#QuexRequestOraclePool",
      "PrivateSetup#CCIPRouter",
      "PrivateSetup#ValueToken",
      "PrivateSetup#ValueTokenPriceFeed",
      "PrivateSetup#MintValueTokenToDeployer",
    ]);

    const source = await fs.readFile("ignition/modules/PrivateSetup.ts", "utf8");
    expect(source).to.include('m.contract("MockCreateX"');
    expect(source).to.include('m.contract("MockQuexCore"');
    expect(source).to.include('m.contract("MockQuexRequestOraclePool"');
    expect(source).to.include('m.contract("MockCCIPRouter"');
    expect(source).to.include('m.contract("MockERC20"');
    expect(source).to.include('m.contract("MockChainlinkAggregator"');
    expect(source).to.include('"USDC"');
    expect(source).to.include("100_000n * 10n ** 8n");
  });
});

describe("Foundation core configuration Ignition module", function () {
  it("exports the core configuration module", async function () {
    expect(FoundationCoreConfigModule.id).to.equal("FoundationCoreConfig");
  });

  it("configures wildcard oracle, value token pricing, oracle timeout, and protocol fee", async function () {
    const futureIds = Array.from(FoundationCoreConfigModule.futures, (future) => future.id);

    expect(futureIds).to.include.members([
      "FoundationCoreConfig#SetWildcardOracle",
      "FoundationCoreConfig#SetValueTokenConfig",
      "FoundationCoreConfig#SetOracleRequestTimeout",
      "FoundationCoreConfig#SetNavRequestCooldown",
      "FoundationCoreConfig#SetProtocolFee",
    ]);
    expect(futureIds).to.not.include("FoundationCoreConfig#SetValueToken");

    const source = await fs.readFile("ignition/modules/FoundationCoreConfig.ts", "utf8");
    expect(source).to.include("setVaultOracle");
    expect(source).to.include("setValueTokenConfig");
    expect(source).to.include("valueTokenPriceFeed");
    expect(source).to.include("setOracleRequestTimeout");
    expect(source).to.include("setNavRequestCooldown");
    expect(source).to.include("setProtocolFee");
    expect(source).to.include('m.getParameter("zeroUFarmFee", false)');
    expect(source).to.include('"setProtocolFee", [ZeroAddress, protocolFee, zeroUFarmFee]');
    expect(source).to.include("300n");
    expect(source).to.include("3_000_000_000_000_000n");
    expect(source).to.include("ZeroAddress");
  });
});

describe("Foundation adapters Ignition module", function () {
  it("exports the adapters module", async function () {
    expect(FoundationAdaptersModule.id).to.equal("FoundationAdapters");
  });

  it("deploys adapters and an ERC1967-proxied arbitrary guard", async function () {
    const futureIds = Array.from(FoundationAdaptersModule.futures, (future) => future.id);

    expect(Object.keys(FoundationAdaptersModule.results)).to.have.members([
      "arbitraryAdapterGuard",
      "arbitraryAdapter",
      "crossChainAdapter",
    ]);
    expect(futureIds).to.include.members([
      "FoundationAdapters#ArbitraryAdapterGuardImpl",
      "FoundationAdapters#ArbitraryAdapterGuardProxy",
      "FoundationAdapters#ArbitraryAdapter",
      "FoundationAdapters#CrossChainAdapter",
      "FoundationAdapters#SetWildcardArbitraryAdapter",
      "FoundationAdapters#SetWildcardCrossChainAdapter",
      "FoundationAdapters#SetCrossChainRouter",
      "FoundationAdapters#SetCrossChainFeeToken",
      "FoundationAdapters#SetCrossChainToken",
      "FoundationAdapters#SetCrossChainGasLimit",
      "FoundationAdapters#SetCCIPSelector",
    ]);
    expect(futureIds).to.not.include("FoundationAdapters#ArbitraryAdapterGuardImplementation");

    const source = await fs.readFile("ignition/modules/FoundationAdapters.ts", "utf8");
    expect(Object.keys(FoundationAdaptersModule.results)).to.not.include.members([
      "arbitraryAdapterGuardImplementation",
      "arbitraryAdapterGuardProxy",
    ]);
    expect(source).to.include('m.contract("ERC1967Proxy"');
    expect(source).to.include('m.contract("ArbitraryAdapterGuard"');
    expect(source).to.include('m.contract("ArbitraryAdapter"');
    expect(source).to.include('m.contract("CrossChainAdapter"');
    expect(source).to.include("setVaultAdapter");
    expect(source).to.include("setCrossChainRouter");
    expect(source).to.include("setCrossChainFeeToken");
    expect(source).to.include("setCrossChainToken");
    expect(source).to.include("setCrossChainGasLimit");
    expect(source).to.include("setCCIPSelector");
    expect(source).to.include('id("ufarm.adapter.arbitrary")');
    expect(source).to.include('id("ufarm.adapter.cross-chain")');
  });

  it("serializes Foundation adapter transaction-bearing futures for public RPC nonce handling", function () {
    const futures = new Map(Array.from(FoundationAdaptersModule.futures, (future) => [future.id, future]));
    const transactionFutureIds = Array.from(FoundationAdaptersModule.futures)
      .filter((future) => future.type.includes("CONTRACT_DEPLOYMENT") || future.type === "CONTRACT_CALL")
      .map((future) => future.id);

    expect(transactionFutureIds).to.have.members([
      "FoundationAdapters#ArbitraryAdapterGuardImpl",
      "FoundationAdapters#ArbitraryAdapterGuardProxy",
      "FoundationAdapters#ArbitraryAdapter",
      "FoundationAdapters#SetWildcardArbitraryAdapter",
      "FoundationAdapters#CrossChainAdapter",
      "FoundationAdapters#SetWildcardCrossChainAdapter",
      "FoundationAdapters#SetCrossChainRouter",
      "FoundationAdapters#SetCrossChainFeeToken",
      "FoundationAdapters#SetCrossChainToken",
      "FoundationAdapters#SetCrossChainGasLimit",
      "FoundationAdapters#SetCCIPSelector",
    ]);

    const expectedDependencies = new Map([
      ["FoundationAdapters#ArbitraryAdapterGuardProxy", "FoundationAdapters#ArbitraryAdapterGuardImpl"],
      ["FoundationAdapters#ArbitraryAdapter", "FoundationAdapters#ArbitraryAdapterGuardProxy"],
      ["FoundationAdapters#SetWildcardArbitraryAdapter", "FoundationAdapters#ArbitraryAdapter"],
      ["FoundationAdapters#CrossChainAdapter", "FoundationAdapters#SetWildcardArbitraryAdapter"],
      ["FoundationAdapters#SetWildcardCrossChainAdapter", "FoundationAdapters#CrossChainAdapter"],
      ["FoundationAdapters#SetCrossChainRouter", "FoundationAdapters#SetWildcardCrossChainAdapter"],
      ["FoundationAdapters#SetCrossChainFeeToken", "FoundationAdapters#SetCrossChainRouter"],
      ["FoundationAdapters#SetCrossChainToken", "FoundationAdapters#SetCrossChainFeeToken"],
      ["FoundationAdapters#SetCrossChainGasLimit", "FoundationAdapters#SetCrossChainToken"],
      ["FoundationAdapters#SetCCIPSelector", "FoundationAdapters#SetCrossChainGasLimit"],
    ]);

    for (const [futureId, dependencyId] of expectedDependencies) {
      const future = futures.get(futureId);
      expect(future, futureId).to.not.equal(undefined);
      expect(Array.from(future!.dependencies, (dependency) => dependency.id)).to.include(dependencyId);
    }
  });

  it("exposes a unified CCIP vault exec script", async function () {
    const script = await fs.readFile("scripts/exec-vault-ccip.ts", "utf8");

    expect(script).to.include("--action");
    expect(script).to.include("send-tokens");
    expect(script).to.include("manualResendCrossChainMessage");
    expect(script).to.include("manualResetCrossChainSession");
    expect(script).to.include("incoming-transfer-request");
    expect(script).to.include("transfer-receipt");
    expect(script).to.include("MockCCIPRouter");
  });
});
