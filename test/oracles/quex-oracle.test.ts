import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const PATCH_ID = ethers.id("PATCH");
const SCHEMA_ID = ethers.id("SCHEMA");
const FILTER_ID = ethers.id("FILTER");
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const OracleFlow = {
  Invalid: 1n,
  InvalidRequest: 2n,
  Active: 3n,
  NoneActive: 4n,
  NotTimedOut: 5n,
  Cooldown: 6n,
  InvalidValuationTime: 7n,
};

async function deployFixture(subscriptionId = 77n) {
  const [authority, registrar, outsider, curatorOwner, vaultOwner, assetManager] = await ethers.getSigners();

  const { core } = await deployConfiguredCore(ethers, authority);
  await core.setPermissionMask(registrar.address, (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER);

  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await configureValueToken(ethers, core, asset);
  const quexCore = await ethers.deployContract("MockQuexCore");
  const requestPool = await ethers.deployContract("MockQuexRequestOraclePool");
  const oracleImpl = await ethers.deployContract("UFarmQuexOracle");
  const oracleInitData = oracleImpl.interface.encodeFunctionData("initialize", [
    await core.getAddress(),
    await quexCore.getAddress(),
    subscriptionId,
  ]);
  const oracleProxy = await ethers.deployContract("ERC1967Proxy", [await oracleImpl.getAddress(), oracleInitData]);
  const oracle = await ethers.getContractAt("UFarmQuexOracle", await oracleProxy.getAddress());

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("quex-curator"));
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
    .createVault(ethers.id("quex-vault"), vaultOwner.address, "UFarm Quex Vault", "uQUEX", await asset.getAddress());
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
  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER);
  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

  const baseRequest = {
    method: 0,
    host: "api.ufarm.test",
    path: "/nav",
    headers: [{ key: "accept", value: "application/json" }],
    parameters: [{ key: "network", value: "31337" }],
    body: "0x",
  };

  async function configure() {
    await oracle
      .connect(registrar)
      .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n);
  }

  async function startVaultRequest() {
    await vault.connect(assetManager).getFunction("settleRequests()")();
    return vault.activeOracleRequestId();
  }

  return {
    authority,
    registrar,
    outsider,
    curatorOwner,
    vaultOwner,
    assetManager,
    core,
    quexCore,
    requestPool,
    oracle,
    oracleImpl,
    oracleProxy,
    curator,
    vault,
    asset,
    baseRequest,
    configure,
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

describe("UFarmQuexOracle", function () {
  it("requires MEMBER and CORE_ORACLE_MANAGER to configure action data", async function () {
    const { core, oracle, registrar, outsider, requestPool, baseRequest } = await deployFixture();

    await expect(
      oracle
        .connect(outsider)
        .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n),
    )
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);

    await core.setPermissionMask(outsider.address, CORE_ORACLE_MANAGER);
    await expect(
      oracle
        .connect(outsider)
        .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n),
    )
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);

    await expect(
      oracle
        .connect(registrar)
        .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n),
    )
      .to.emit(oracle, "QuexActionDataUpdated")
      .withArgs(1n);

    expect(await oracle.flowVersion()).to.equal(1n);
  });

  it("is initialized behind an ERC1967 proxy and authorizes upgrades through core OWNER permission", async function () {
    const { oracle, oracleImpl, outsider, registrar } = await deployFixture();
    const nextImplementation = await ethers.deployContract("UFarmQuexOracle");

    await expect(oracleImpl.initialize(outsider.address, outsider.address, 1n)).to.be.revert(ethers);
    await expect(oracle.connect(registrar).upgradeToAndCall(await nextImplementation.getAddress(), "0x"))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(registrar.address);
    await oracle.upgradeToAndCall(await nextImplementation.getAddress(), "0x");
  });

  it("updates subscription id silently without changing flow version", async function () {
    const { oracle, registrar, requestPool, baseRequest } = await deployFixture();
    await oracle
      .connect(registrar)
      .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n);

    await expect(oracle.connect(registrar).setQuexSubscriptionId(88n)).to.not.emit(oracle, "QuexActionDataUpdated");
    expect(await oracle.subscriptionId()).to.equal(88n);
    expect(await oracle.flowVersion()).to.equal(1n);
  });

  it("allows deployment with a zero subscription and blocks requests until configured", async function () {
    const { oracle, vault, assetManager, registrar, configure, startVaultRequest } = await deployFixture(0n);
    await configure();

    await expect(startVaultRequest()).to.be.revertedWithCustomError(oracle, "InvalidConfig");

    await oracle.connect(registrar).setQuexSubscriptionId(77n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.emit(oracle, "QuexRequestCreated");
  });

  it("allows setting subscription to zero without invalidating cached flows", async function () {
    const { oracle, registrar, vault, assetManager, configure } = await deployFixture();
    await configure();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const cached = await oracle.vaultFlow(await vault.getAddress());

    await oracle.connect(registrar).setQuexSubscriptionId(0n);

    expect((await oracle.vaultFlow(await vault.getAddress())).flowId).to.equal(cached.flowId);
  });

  it("invalidates every legacy flow cache by incrementing the global version", async function () {
    const { oracle, registrar, vault, assetManager, configure } = await deployFixture();
    await configure();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const previousVersion = await oracle.flowVersion();

    await expect(oracle.connect(registrar).invalidateFlowCache())
      .to.emit(oracle, "QuexFlowCacheInvalidated")
      .withArgs(previousVersion + 1n);
    expect(await oracle.flowVersion()).to.equal(previousVersion + 1n);
  });

  it("rejects base request query parameter with reserved key id in any case variant", async function () {
    const { oracle, registrar, requestPool, baseRequest } = await deployFixture();
    for (const key of ["id", "iD", "Id", "ID"]) {
      const invalidRequest = {
        ...baseRequest,
        parameters: [...baseRequest.parameters, { key, value: "shadow" }],
      };

      await expect(
        oracle
          .connect(registrar)
          .setQuexActionData(
            await requestPool.getAddress(),
            invalidRequest,
            PATCH_ID,
            SCHEMA_ID,
            FILTER_ID,
            1_000_000n,
          ),
      ).to.be.revertedWithCustomError(oracle, "InvalidConfig");
    }
  });

  it("creates a per-vault flow, appends vault id, and stores request routing", async function () {
    const { oracle, quexCore, requestPool, vault, assetManager, configure } = await deployFixture();
    await configure();
    const vaultAddress = await vault.getAddress();

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(oracle, "QuexFlowCreated")
      .withArgs(vaultAddress, 1n, 1n)
      .and.to.emit(oracle, "QuexRequestCreated")
      .withArgs(vaultAddress, 1n);

    expect(await oracle.vaultByRequestId(1n)).to.equal(vaultAddress);
    expect(await quexCore.flowByRequestId(1n)).to.equal(1n);
    expect(await quexCore.subscriptionByRequestId(1n)).to.equal(77n);

    const flow = await quexCore.flow(1n);
    expect(flow.consumer).to.equal(await oracle.getAddress());
    expect(flow.pool).to.equal(await requestPool.getAddress());

    const requestId = await requestPool.lastRequestId();
    expect(await requestPool.requestParameterCount(requestId)).to.equal(2n);
    expect(await requestPool.requestParameter(requestId, 1)).to.deep.equal(["id", vaultAddress.toLowerCase()]);
  });

  it("validates Quex callback, decodes NAV, and forwards to the mapped vault", async function () {
    const { oracle, quexCore, vault, configure, startVaultRequest } = await deployFixture();
    await configure();
    const requestId = await startVaultRequest();

    const response = {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1_000_000n]),
    };

    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, response))
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await oracle.getAddress(), requestId, 1_000_000n * 10n ** 12n, response.timestamp);

    expect(await oracle.vaultByRequestId(requestId)).to.equal(ethers.ZeroAddress);
  });

  it("rejects a Quex flow id that collides with a pending request id", async function () {
    const { oracle, quexCore, vault, configure, startVaultRequest } = await deployFixture();
    await configure();
    const requestId = await startVaultRequest();
    const response = {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1_000_000n]),
    };

    expect(requestId).to.equal(1n);
    await expect(quexCore.submitResponseWithIdType(await oracle.getAddress(), 1n, requestId, response, 1n))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);

    expect(await oracle.vaultByRequestId(requestId)).to.equal(await vault.getAddress());
    expect(await vault.activeOracleRequestId()).to.equal(requestId);
  });

  it("rejects replayed Quex callbacks for the same request id after successful delivery", async function () {
    const { oracle, quexCore, configure, startVaultRequest } = await deployFixture();
    await configure();
    const requestId = await startVaultRequest();

    const response = {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1_000_000n]),
    };

    await quexCore.submitResponse(await oracle.getAddress(), requestId, response);
    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, response))
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
  });

  it("rolls back request mapping deletion when the vault rejects the callback", async function () {
    const { oracle, quexCore, vault, configure, startVaultRequest } = await deployFixture();
    await configure();
    const requestId = await startVaultRequest();

    const response = {
      timestamp: 1n,
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1_000_000n]),
    };

    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, response)).to.be.revertedWithCustomError(
      vault,
      "OracleFlowError",
    );
    expect(await oracle.vaultByRequestId(requestId)).to.equal(await vault.getAddress());
  });

  it("rejects invalid Quex callbacks", async function () {
    const { oracle, quexCore, outsider, configure, startVaultRequest } = await deployFixture();
    await configure();
    const requestId = await startVaultRequest();

    const goodValue = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1_000_000n]);
    await expect(oracle.connect(outsider).quexCallback(1n, { timestamp: 1234n, errorCode: 0n, value: goodValue }, 0n))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);

    await expect(
      quexCore.submitResponse(await oracle.getAddress(), 99n, { timestamp: 1234n, errorCode: 0n, value: goodValue }),
    )
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);

    await expect(
      quexCore.submitResponse(await oracle.getAddress(), requestId, {
        timestamp: 1234n,
        errorCode: 7n,
        value: goodValue,
      }),
    )
      .to.be.revertedWithCustomError(oracle, "QuexResponseError")
      .withArgs(7n);

    await expect(
      quexCore.submitResponse(await oracle.getAddress(), requestId, { timestamp: 0n, errorCode: 0n, value: goodValue }),
    )
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);

    await expect(
      quexCore.submitResponse(await oracle.getAddress(), requestId, {
        timestamp: 1n << 64n,
        errorCode: 0n,
        value: goodValue,
      }),
    )
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);

    await expect(
      quexCore.submitResponse(await oracle.getAddress(), requestId, {
        timestamp: 1234n,
        errorCode: 0n,
        value: "0x1234",
      }),
    ).to.be.revertedWithoutReason();
  });

  it("requestNav rejects zero vault and invalid request ids from Quex core", async function () {
    const { oracle, quexCore, vault, assetManager, configure } = await deployFixture();
    await configure();

    await expect(oracle.requestNav(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "InvalidAddress");

    await quexCore.setNextRequestId(0n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);

    await quexCore.setNextRequestId(1n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await quexCore.setNextRequestId(1n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(oracle, "OracleFlowError")
      .withArgs(OracleFlow.Active);
  });

  it("rejects requestNav caller-vault mismatch, unregistered vaults, and missing config", async function () {
    const { oracle, vault, outsider, authority, assetManager } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const consumer = await ethers.deployContract("MockUFarmOracleConsumer");

    await expect(oracle.connect(outsider).requestNav(vaultAddress))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(outsider.address);

    await expect(consumer.requestNav(await oracle.getAddress()))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(await consumer.getAddress());

    await expect(oracle.requestNav(vaultAddress))
      .to.be.revertedWithCustomError(oracle, "Unauthorized")
      .withArgs(authority.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      oracle,
      "InvalidConfig",
    );
  });

  it("reuses a current flow and recreates it after flow-version-changing config updates", async function () {
    const { oracle, registrar, requestPool, vault, assetManager, baseRequest, configure, quexCore } =
      await deployFixture();
    await configure();
    const vaultAddress = await vault.getAddress();

    await vault.connect(assetManager).getFunction("settleRequests()")();
    expect((await oracle.vaultFlow(vaultAddress)).flowId).to.equal(1n);

    await quexCore.submitResponse(await oracle.getAddress(), 1n, {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]),
    });
    await passVaultCooldown();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    expect((await oracle.vaultFlow(vaultAddress)).flowId).to.equal(1n);

    await oracle
      .connect(registrar)
      .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 2_000_000n);
    await quexCore.submitResponse(await oracle.getAddress(), 2n, {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]),
    });
    await passVaultCooldown();
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const refreshed = await oracle.vaultFlow(vaultAddress);
    expect(refreshed.flowId).to.equal(2n);
    expect(refreshed.flowVersion).to.equal(2n);
  });

  it("uses updated subscription id for subsequent requests without recreating the current flow", async function () {
    const { oracle, registrar, vault, assetManager, configure, quexCore } = await deployFixture();
    await configure();
    const vaultAddress = await vault.getAddress();

    await vault.connect(assetManager).getFunction("settleRequests()")();
    const firstFlow = await oracle.vaultFlow(vaultAddress);
    expect(firstFlow.flowId).to.equal(1n);
    expect(firstFlow.flowVersion).to.equal(1n);
    expect(await quexCore.flowByRequestId(1n)).to.equal(1n);
    expect(await quexCore.subscriptionByRequestId(1n)).to.equal(77n);

    await oracle.connect(registrar).setQuexSubscriptionId(88n);
    await quexCore.submitResponse(await oracle.getAddress(), 1n, {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]),
    });
    await passVaultCooldown();
    await vault.connect(assetManager).getFunction("settleRequests()")();

    const secondFlow = await oracle.vaultFlow(vaultAddress);
    expect(secondFlow.flowId).to.equal(1n);
    expect(secondFlow.flowVersion).to.equal(1n);
    expect(await oracle.flowVersion()).to.equal(1n);
    expect(await quexCore.flowByRequestId(2n)).to.equal(1n);
    expect(await quexCore.subscriptionByRequestId(2n)).to.equal(88n);
  });
});
