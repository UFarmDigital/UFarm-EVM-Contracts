import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const OracleFlow = { InvalidRequest: 2n, InvalidValuationTime: 7n };

async function deployBatchOracle(
  core: string,
  quexCore: string,
  pool: string,
  subscriptionId = 77n,
  gasLimit = 1_000_000n,
) {
  const implementation = await ethers.deployContract("UFarmQuexBatchOracle");
  const initData = implementation.interface.encodeFunctionData("initialize", [
    core,
    quexCore,
    subscriptionId,
    pool,
    gasLimit,
  ]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await implementation.getAddress(), initData]);
  return ethers.getContractAt("UFarmQuexBatchOracle", await proxy.getAddress());
}

async function deployFixture(subscriptionId = 77n) {
  const [authority, registrar, outsider, curatorOwner, vaultOwner, assetManager] = await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, authority);
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER);

  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await configureValueToken(ethers, core, asset);
  const quexCore = await ethers.deployContract("MockQuexCore");
  const requestPool = await ethers.deployContract("MockQuexRequestOraclePool");
  const oracle = await deployBatchOracle(
    await core.getAddress(),
    await quexCore.getAddress(),
    await requestPool.getAddress(),
    subscriptionId,
  );

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("quex-batch-curator"));
  const curatorReceipt = await curatorTx.wait();
  const curatorEvent = curatorReceipt?.logs
    .map((log) => {
      try {
        return core.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CuratorCreated");
  const curator = await ethers.getContractAt("UFarmCurator", curatorEvent!.args.curator as string);

  const vaultTx = await curator
    .connect(curatorOwner)
    .createVault(
      ethers.id("quex-batch-vault"),
      vaultOwner.address,
      "UFarm Quex Batch Vault",
      "uQB",
      await asset.getAddress(),
    );
  const vaultReceipt = await vaultTx.wait();
  const vaultEvent = vaultReceipt?.logs
    .map((log) => {
      try {
        return curator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "VaultCreated");
  const vault = await ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);
  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, MEMBER | VAULT_SETTLE_MANAGER);
  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

  async function startVaultRequest() {
    await vault.connect(assetManager).getFunction("settleRequests()")();
    return vault.activeOracleRequestId();
  }

  return {
    authority,
    registrar,
    outsider,
    assetManager,
    core,
    quexCore,
    requestPool,
    oracle,
    vault,
    startVaultRequest,
  };
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function passVaultCooldown() {
  await ethers.provider.send("evm_increaseTime", [300]);
  await ethers.provider.send("evm_mine", []);
}

function response(timestamp: bigint, nav = 1_000_000n) {
  return {
    timestamp,
    errorCode: 0n,
    value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [nav]),
  };
}

describe("UFarmQuexBatchOracle", function () {
  it("validates initialization configuration and protects implementation initialization", async function () {
    const [caller] = await ethers.getSigners();
    const implementation = await ethers.deployContract("UFarmQuexBatchOracle");
    await expect(
      deployBatchOracle(ethers.ZeroAddress, caller.address, caller.address),
    ).to.be.revertedWithCustomError(implementation, "InvalidAddress");
    await expect(
      deployBatchOracle(caller.address, ethers.ZeroAddress, caller.address),
    ).to.be.revertedWithCustomError(implementation, "InvalidAddress");
    await expect(
      deployBatchOracle(caller.address, caller.address, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(implementation, "InvalidAddress");
    await expect(deployBatchOracle(caller.address, caller.address, caller.address, 0n, 0n)).to.be.revertedWithCustomError(
      implementation,
      "InvalidConfig",
    );
    await expect(implementation.initialize(caller.address, caller.address, 0n, caller.address, 1n)).to.be.revert(ethers);
  });

  it("requires MEMBER and CORE_ORACLE_MANAGER for action configuration and versions every update", async function () {
    const { core, oracle, registrar, outsider, vault } = await deployFixture();
    const vaultAddress = await vault.getAddress();

    await expect(oracle.connect(outsider).setQuexActionData(vaultAddress, 123n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);
    await core.setPermissionMask(outsider.address, CORE_ORACLE_MANAGER);
    await expect(oracle.connect(outsider).setQuexActionData(vaultAddress, 123n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);

    await expect(oracle.connect(registrar).setQuexActionData(vaultAddress, 123n))
      .to.emit(oracle, "QuexBatchActionDataUpdated")
      .withArgs(vaultAddress, 123n, 1n);
    expect(await oracle.vaultActionData(vaultAddress)).to.deep.equal([123n, 1n]);

    await expect(oracle.connect(registrar).setQuexActionData(vaultAddress, 123n))
      .to.emit(oracle, "QuexBatchActionDataUpdated")
      .withArgs(vaultAddress, 123n, 2n);

    await oracle.connect(registrar).setQuexActionData(vaultAddress, 0n);
    expect(await oracle.vaultActionData(vaultAddress)).to.deep.equal([0n, 3n]);
  });

  it("validates action vaults only when enabling an action", async function () {
    const { oracle, registrar } = await deployFixture();
    const unregistered = await ethers.deployContract("MockUFarmOracleConsumer");
    const unregisteredAddress = await unregistered.getAddress();
    await expect(oracle.connect(registrar).setQuexActionData(ethers.ZeroAddress, 0n)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAddress",
    );
    await expect(oracle.connect(registrar).setQuexActionData(unregisteredAddress, 123n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(unregisteredAddress);
    await expect(oracle.connect(registrar).setQuexActionData(unregisteredAddress, 0n)).to.emit(
      oracle,
      "QuexBatchActionDataUpdated",
    );
  });

  it("accepts zero subscriptions but fails new requests closed while zero", async function () {
    const { oracle, registrar, vault, assetManager } = await deployFixture(0n);
    await oracle.connect(registrar).setQuexActionData(await vault.getAddress(), 123n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      oracle,
      "InvalidConfig",
    );
    await oracle.connect(registrar).setQuexSubscriptionId(77n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.emit(oracle, "QuexRequestCreated");
    await oracle.connect(registrar).setQuexSubscriptionId(0n);
    expect(await oracle.subscriptionId()).to.equal(0n);
  });

  it("protects and validates global configuration without invalidating cached flows", async function () {
    const { oracle, registrar, outsider, requestPool, vault, assetManager } = await deployFixture();
    await expect(oracle.connect(outsider).setQuexConfig(outsider.address, 1n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);
    await expect(oracle.connect(registrar).setQuexConfig(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      oracle,
      "InvalidAddress",
    );
    await expect(oracle.connect(registrar).setQuexConfig(await requestPool.getAddress(), 0n)).to.be.revertedWithCustomError(
      oracle,
      "InvalidConfig",
    );

    await oracle.connect(registrar).setQuexActionData(await vault.getAddress(), 123n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const cached = await oracle.vaultFlow(await vault.getAddress());
    await expect(oracle.connect(registrar).setQuexConfig(outsider.address, 2_000_000n))
      .to.emit(oracle, "QuexBatchConfigUpdated")
      .withArgs(outsider.address, 2_000_000n);
    expect(await oracle.vaultFlow(await vault.getAddress())).to.deep.equal(cached);
  });

  it("authorizes upgrades through core OWNER only", async function () {
    const { oracle, registrar } = await deployFixture();
    const nextImplementation = await ethers.deployContract("UFarmQuexBatchOracle");
    await expect(oracle.connect(registrar).upgradeToAndCall(await nextImplementation.getAddress(), "0x"))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(registrar.address);
    await oracle.upgradeToAndCall(await nextImplementation.getAddress(), "0x");
  });

  it("creates direct flows with exact fields and reuses the current cache", async function () {
    const { oracle, registrar, vault, assetManager, quexCore, requestPool } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    const cached = await oracle.vaultFlow(vaultAddress);
    const flow = await quexCore.flow(cached.flowId);
    expect(flow.actionId).to.equal(123n);
    expect(flow.pool).to.equal(await requestPool.getAddress());
    expect(flow.gasLimit).to.equal(1_000_000n);
    expect(flow.consumer).to.equal(await oracle.getAddress());
    expect(flow.callback).to.equal(oracle.interface.getFunction("quexCallback")!.selector);
    expect(await requestPool.lastRequestId()).to.equal(ethers.ZeroHash);

    await quexCore.submitResponse(await oracle.getAddress(), 1n, response(await nextBlockTimestamp(), 0n));
    await passVaultCooldown();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    expect((await oracle.vaultFlow(vaultAddress)).flowId).to.equal(cached.flowId);
  });

  it("keeps cached flows across global changes until explicit cache invalidation", async function () {
    const { oracle, registrar, outsider, vault, assetManager, quexCore } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await oracle.connect(registrar).setQuexConfig(outsider.address, 2_000_000n);
    await quexCore.submitResponse(await oracle.getAddress(), 1n, response(await nextBlockTimestamp(), 0n));
    await passVaultCooldown();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    expect((await oracle.vaultFlow(vaultAddress)).flowId).to.equal(1n);

    await quexCore.submitResponse(await oracle.getAddress(), 2n, response(await nextBlockTimestamp(), 0n));
    await passVaultCooldown();
    await oracle.connect(registrar).invalidateFlowCache([vaultAddress]);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const refreshed = await oracle.vaultFlow(vaultAddress);
    const flow = await quexCore.flow(refreshed.flowId);
    expect(refreshed.flowId).to.equal(2n);
    expect(flow.pool).to.equal(outsider.address);
    expect(flow.gasLimit).to.equal(2_000_000n);
  });

  it("re-setting an action recreates its flow and disabling it blocks cache reuse", async function () {
    const { oracle, registrar, vault, assetManager, quexCore } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await quexCore.submitResponse(await oracle.getAddress(), 1n, response(await nextBlockTimestamp(), 0n));
    await passVaultCooldown();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    expect((await oracle.vaultFlow(vaultAddress)).flowId).to.equal(2n);

    await quexCore.submitResponse(await oracle.getAddress(), 2n, response(await nextBlockTimestamp(), 0n));
    await passVaultCooldown();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 0n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      oracle,
      "InvalidConfig",
    );
  });

  it("increments duplicate cache invalidations and reverts invalidation batches atomically", async function () {
    const { oracle, registrar, vault } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).invalidateFlowCache([registrar.address]);
    expect(await oracle.vaultActionData(registrar.address)).to.deep.equal([0n, 1n]);

    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await oracle.connect(registrar).invalidateFlowCache([vaultAddress, vaultAddress]);
    expect(await oracle.vaultActionData(vaultAddress)).to.deep.equal([123n, 3n]);

    await expect(oracle.connect(registrar).invalidateFlowCache([vaultAddress, ethers.ZeroAddress])).to.be.revertedWithCustomError(
      oracle,
      "InvalidAddress",
    );
    expect(await oracle.vaultActionData(vaultAddress)).to.deep.equal([123n, 3n]);
  });

  it("enforces the callback trust boundary and preserves pending requests on rejection", async function () {
    const { oracle, registrar, outsider, vault, quexCore, startVaultRequest } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    const requestId = await startVaultRequest();
    const flowId = (await oracle.vaultFlow(vaultAddress)).flowId;
    const good = response(await nextBlockTimestamp());

    await expect(oracle.connect(outsider).quexCallback(requestId, good, 0n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);
    await expect(quexCore.submitResponseWithIdType(await oracle.getAddress(), flowId, requestId, good, 1n))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
    await expect(quexCore.submitResponse(await oracle.getAddress(), 99n, good))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, { ...good, errorCode: 7n }))
      .to.be.revertedWithCustomError(oracle, "QuexResponseError")
      .withArgs(7n);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, { ...good, timestamp: 0n }))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, { ...good, timestamp: 1n << 64n }))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, { ...good, value: "0x1234" })).to.be
      .revertedWithoutReason();
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, response(1n))).to.be.revertedWithCustomError(
      vault,
      "OracleFlowError",
    );
    expect(await oracle.vaultByRequestId(requestId)).to.equal(vaultAddress);
  });

  it("accepts an existing callback after subscription is disabled and rejects replay", async function () {
    const { oracle, registrar, vault, quexCore, startVaultRequest } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    const requestId = await startVaultRequest();
    const flowId = (await oracle.vaultFlow(vaultAddress)).flowId;
    const good = response(await nextBlockTimestamp());
    await oracle.connect(registrar).setQuexSubscriptionId(0n);

    await expect(quexCore.submitResponseWithIdType(await oracle.getAddress(), flowId, requestId, good, 0n))
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await oracle.getAddress(), requestId, 1_000_000n * 10n ** 12n, good.timestamp);
    expect(await oracle.vaultByRequestId(requestId)).to.equal(ethers.ZeroAddress);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, good))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
  });

  it("rejects invalid request creation and request callers", async function () {
    const { oracle, registrar, outsider, vault, assetManager, quexCore } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    await oracle.connect(registrar).setQuexActionData(vaultAddress, 123n);
    await expect(oracle.requestNav(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "InvalidAddress");
    await expect(oracle.connect(outsider).requestNav(vaultAddress))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);
    await quexCore.setNextRequestId(0n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
  });
});
