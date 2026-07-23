import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const PATCH_ID = ethers.id("PATCH");
const SCHEMA_ID = ethers.id("SCHEMA");
const FILTER_ID = ethers.id("FILTER");
const VAULT_SETTLE_MANAGER = 1n << 1n;
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const ASSET_UNIT = 10n ** 18n;
const QUEX_UNIT = 10n ** 6n;

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, assetManager] = await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());

  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const quexCore = await ethers.deployContract("MockQuexCore");
  const requestPool = await ethers.deployContract("MockQuexRequestOraclePool");
  const oracleImpl = await ethers.deployContract("UFarmQuexOracle");
  const oracleInitData = oracleImpl.interface.encodeFunctionData("initialize", [
    await core.getAddress(),
    await quexCore.getAddress(),
    77n,
  ]);
  const oracleProxy = await ethers.deployContract("ERC1967Proxy", [await oracleImpl.getAddress(), oracleInitData]);
  const oracle = await ethers.getContractAt("UFarmQuexOracle", await oracleProxy.getAddress());

  await core.setPermissionMask(registrar.address, (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER);
  await configureValueToken(ethers, core, asset);

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
  await asset.mint(owner.address, 1_000_000n * ASSET_UNIT);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n * ASSET_UNIT);

  const baseRequest = {
    method: 0,
    host: "api.ufarm.test",
    path: "/nav",
    headers: [],
    parameters: [],
    body: "0x",
  };
  await oracle
    .connect(registrar)
    .setQuexActionData(await requestPool.getAddress(), baseRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 1_000_000n);
  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

  return { core, escrow, vault, oracle, quexCore, requestPool, asset, owner, assetManager, registrar };
}

async function seedShares(fixture: Awaited<ReturnType<typeof deployFixture>>, amount: bigint) {
  const { vault, asset, owner, assetManager } = fixture;
  await asset.connect(owner).approve(await vault.escrow(), amount);
  await vault.connect(owner).requestDeposit(amount, owner.address, owner.address);
  await settleWithQuexOracle(fixture, assetManager, 0n);
  await vault.connect(owner).deposit(0n, owner.address, owner.address);
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function advancePastSettlementCooldown(vault: any) {
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
}

async function settleWithQuexOracle(fixture: Awaited<ReturnType<typeof deployFixture>>, signer: any, nav: bigint) {
  const { vault, oracle, quexCore } = fixture;
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const response = {
    timestamp: await nextBlockTimestamp(),
    errorCode: 0n,
    value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [nav]),
  };
  return quexCore.submitResponse(await oracle.getAddress(), requestId, response);
}

describe("UFarmQuexOracle vault integration", function () {
  it("starts a Quex-backed oracle request and settles a deposit callback", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, quexCore, asset, escrow, owner, assetManager } = fixture;

    await vault.connect(owner).requestDeposit(100n * ASSET_UNIT, owner.address, owner.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);
    const requestId = await vault.activeOracleRequestId();

    const valuationTimestamp = await nextBlockTimestamp();
    const response = {
      timestamp: valuationTimestamp,
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n * QUEX_UNIT]),
    };

    await expect(quexCore.submitResponse(await oracle.getAddress(), requestId, response))
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await oracle.getAddress(), requestId, 100n * ASSET_UNIT, valuationTimestamp);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n * ASSET_UNIT);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
  });

  it("settles a redeem callback through the existing vault path", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, quexCore, owner, assetManager } = fixture;
    await seedShares(fixture, 100n * ASSET_UNIT);

    await vault.connect(owner).requestRedeem(40n * ASSET_UNIT, owner.address, owner.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const requestId = await vault.activeOracleRequestId();

    await quexCore.submitResponse(await oracle.getAddress(), requestId, {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n * QUEX_UNIT]),
    });

    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n * ASSET_UNIT);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("recreates stale flow through vault request path after config update", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, quexCore, assetManager, registrar, requestPool, owner } = fixture;

    await vault.connect(owner).requestDeposit(10n * ASSET_UNIT, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const firstRequestId = await vault.activeOracleRequestId();
    const initialFlow = await oracle.vaultFlow(await vault.getAddress());

    const updatedRequest = {
      method: 0,
      host: "api.ufarm.test",
      path: "/nav-v2",
      headers: [],
      parameters: [{ key: "version", value: "2" }],
      body: "0x",
    };
    await oracle
      .connect(registrar)
      .setQuexActionData(await requestPool.getAddress(), updatedRequest, PATCH_ID, SCHEMA_ID, FILTER_ID, 2_000_000n);

    await quexCore.submitResponse(await oracle.getAddress(), firstRequestId, {
      timestamp: await nextBlockTimestamp(),
      errorCode: 0n,
      value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n * QUEX_UNIT]),
    });

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(owner).requestDeposit(20n * ASSET_UNIT, owner.address, owner.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const secondRequestId = await vault.activeOracleRequestId();
    const lastPoolRequestId = await requestPool.lastRequestId();
    expect(lastPoolRequestId).to.equal(secondRequestId);
    expect(await requestPool.requestParameterCount(lastPoolRequestId)).to.equal(2n);
    expect(await requestPool.requestParameter(lastPoolRequestId, 0)).to.deep.equal(["version", "2"]);
    expect(await requestPool.requestParameter(lastPoolRequestId, 1)).to.deep.equal([
      "id",
      (await vault.getAddress()).toLowerCase(),
    ]);
    const refreshedFlow = await oracle.vaultFlow(await vault.getAddress());
    expect(refreshedFlow.flowId).to.not.equal(initialFlow.flowId);
    expect(refreshedFlow.flowVersion).to.equal(2n);
  });
});
