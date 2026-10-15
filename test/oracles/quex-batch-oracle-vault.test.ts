import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const ASSET_UNIT = 10n ** 18n;
const QUEX_UNIT = 10n ** 6n;

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, assetManager] = await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, authority);
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER);

  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await configureValueToken(ethers, core, asset);
  const quexCore = await ethers.deployContract("MockQuexCore");
  const requestPool = await ethers.deployContract("MockQuexRequestOraclePool");
  const oracleImpl = await ethers.deployContract("UFarmQuexBatchOracle");
  const oracleInitData = oracleImpl.interface.encodeFunctionData("initialize", [
    await core.getAddress(),
    await quexCore.getAddress(),
    77n,
    await requestPool.getAddress(),
    1_000_000n,
  ]);
  const oracleProxy = await ethers.deployContract("ERC1967Proxy", [await oracleImpl.getAddress(), oracleInitData]);
  const oracle = await ethers.getContractAt("UFarmQuexBatchOracle", await oracleProxy.getAddress());

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
  await asset.mint(owner.address, 1_000_000n * ASSET_UNIT);
  await asset.connect(owner).approve(await vault.escrow(), 1_000_000n * ASSET_UNIT);
  await oracle.connect(registrar).setQuexActionData(await vault.getAddress(), 123n);
  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

  return { vault, oracle, quexCore, asset, owner, assetManager };
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

async function submitNav(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  requestId: bigint,
  nav: bigint,
  timestamp = 0n,
) {
  const { oracle, quexCore } = fixture;
  return quexCore.submitResponse(await oracle.getAddress(), requestId, {
    timestamp: timestamp || (await nextBlockTimestamp()),
    errorCode: 0n,
    value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [nav]),
  });
}

describe("UFarmQuexBatchOracle vault integration", function () {
  it("settles a deposit callback through the batch oracle", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, quexCore, owner, assetManager } = fixture;

    await vault.connect(owner).requestDeposit(100n * ASSET_UNIT, owner.address, owner.address);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);

    const requestId = await vault.activeOracleRequestId();
    const timestamp = await nextBlockTimestamp();
    await expect(
      quexCore.submitResponse(await oracle.getAddress(), requestId, {
        timestamp,
        errorCode: 0n,
        value: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100n * QUEX_UNIT]),
      }),
    )
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await oracle.getAddress(), requestId, 100n * ASSET_UNIT, timestamp);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n * ASSET_UNIT);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("settles a redeem callback into claimable assets through the batch oracle", async function () {
    const fixture = await deployFixture();
    const { vault, owner, assetManager } = fixture;

    await vault.connect(owner).requestDeposit(100n * ASSET_UNIT, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await submitNav(fixture, await vault.activeOracleRequestId(), 100n * QUEX_UNIT);
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    await vault.connect(owner).requestRedeem(40n * ASSET_UNIT, owner.address, owner.address);
    await advancePastSettlementCooldown(vault);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await fixture.oracle.getAddress(), 2n);
    const requestId = await vault.activeOracleRequestId();
    const timestamp = await nextBlockTimestamp();
    await expect(submitNav(fixture, requestId, 100n * QUEX_UNIT, timestamp))
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await fixture.oracle.getAddress(), requestId, 100n * ASSET_UNIT, timestamp);

    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n * ASSET_UNIT);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });
});
