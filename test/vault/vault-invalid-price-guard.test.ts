import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const CORE_PRICE_GUARD_MANAGER = 1n << 7n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const WAD = 10n ** 18n;

const CoreConfig = {
  InvalidPriceFluctuation: 8n,
};

const OracleFlow = {
  InvalidPrice: 8n,
};
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>, period = 0n) {
  const schedule = steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
  return schedule | (period << 128n);
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, settleManager, configManager, guardManager, outsider] =
    await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const oracle = await ethers.deployContract("MockUFarmOracle");

  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR);
  await core.setPermissionMask(configManager.address, MEMBER | CORE_CONFIG_MANAGER);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("invalid-price-curator"));
  const curatorReceipt = await curatorTx.wait();
  const curatorEvent = curatorReceipt?.logs
    .map((log: any) => {
      try {
        return core.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "CuratorCreated");
  const curator = await ethers.getContractAt("UFarmCurator", curatorEvent!.args.curator as string);

  const vaultTx = await curator
    .connect(curatorOwner)
    .createVault(
      ethers.id("invalid-price-vault"),
      vaultOwner.address,
      "Invalid Price Vault",
      "uIPV",
      await asset.getAddress(),
    );
  const vaultReceipt = await vaultTx.wait();
  const vaultEvent = vaultReceipt?.logs
    .map((log: any) => {
      try {
        return curator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "VaultCreated");
  const vault = await ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);
  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, VAULT_SETTLE_MANAGER);
  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await vault.escrow(), 1_000_000n);

  return {
    core,
    curator,
    vault,
    oracle,
    asset,
    vaultOwner,
    owner,
    settleManager,
    configManager,
    guardManager,
    outsider,
  };
}

async function submitNav(vault: any, oracle: any, settleManager: any, nav: bigint) {
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
  await vault.connect(settleManager).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  await oracle.submitNav(requestId, nav, await nextBlockTimestamp());
  return requestId;
}

async function seedInitialPrice(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const { vault, oracle, asset, owner, settleManager } = fixture;
  await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
  await submitNav(vault, oracle, settleManager, 0n);
  await vault.connect(owner).deposit(0n, owner.address, owner.address);
  expect(await asset.balanceOf(await vault.getAddress())).to.equal(100n);
  expect(await vault.totalSupply()).to.equal(100n);
  expect(await vault.lastTokenPrice()).to.equal(WAD);
}

describe("UFarmVault invalid price guard", function () {
  it("lets CORE_CONFIG_MANAGER configure allowed price fluctuation", async function () {
    const { core, configManager, outsider } = await deployFixture();
    const limit = WAD / 10n;

    await expect(core.connect(outsider).setAllowedPriceFluctuation(limit))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(outsider.address);

    await expect(core.connect(configManager).setAllowedPriceFluctuation(limit))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(ethers.id("ALLOWED_PRICE_FLUCTUATION"), limit);
    expect(await core.allowedPriceFluctuation()).to.equal(limit);

    await expect(core.connect(configManager).setAllowedPriceFluctuation(WAD + 1n))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.InvalidPriceFluctuation);
  });

  it("updates last token price on valid settlements and raises invalid price without settling", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, owner, settleManager, configManager } = fixture;
    await seedInitialPrice(fixture);
    await core.connect(configManager).setAllowedPriceFluctuation(WAD / 10n);

    await submitNav(vault, oracle, settleManager, 105n);
    expect(await vault.lastTokenPrice()).to.equal((105n * WAD) / 100n);
    expect(await vault.isInvalidPrice()).to.equal(false);

    const settlementAllowedAt = await vault.settlementAllowedAt();
    await vault.connect(owner).requestDeposit(10n, owner.address, owner.address);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
    await vault.connect(settleManager).getFunction("settleRequests()")();
    const requestId = await vault.activeOracleRequestId();

    await expect(oracle.submitNav(requestId, 120n, await nextBlockTimestamp()))
      .to.emit(vault, "InvalidPriceRaised")
      .withArgs((105n * WAD) / 100n, (120n * WAD) / 100n, WAD / 10n, 142_857_142_857_142_857n)
      .and.to.emit(vault, "OracleNAVReceived");

    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.isInvalidPrice()).to.equal(true);
    expect(await vault.lastTokenPrice()).to.equal((105n * WAD) / 100n);
    expect(await vault.settlementAllowedAt()).to.equal(settlementAllowedAt);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(10n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("does not accrue fees when NAV is rejected by the invalid price guard", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, oracle, vaultOwner, settleManager, configManager } = fixture;
    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedInitialPrice(fixture);
    await core.connect(configManager).setAllowedPriceFluctuation(WAD / 10n);

    const totalSupplyBefore = await vault.totalSupply();
    await submitNav(vault, oracle, settleManager, 120n);

    expect(await vault.isInvalidPrice()).to.equal(true);
    expect(await vault.totalSupply()).to.equal(totalSupplyBefore);
    expect(await vault.balanceOf(await core.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(0n);
  });

  it("validates NAV against the post-fee share price preview", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, vaultOwner, settleManager, configManager } = fixture;
    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedInitialPrice(fixture);
    await core.connect(configManager).setAllowedPriceFluctuation(WAD / 10n);

    await submitNav(vault, oracle, settleManager, 112n);

    const totalSupply = await vault.totalSupply();
    expect(await vault.isInvalidPrice()).to.equal(false);
    expect(totalSupply).to.be.gt(100n);
    expect(await vault.lastTokenPrice()).to.equal((112n * WAD) / totalSupply);
  });

  it("locks finance paths until CORE_PRICE_GUARD_MANAGER resets invalid price", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, owner, settleManager, configManager, guardManager, outsider } = fixture;
    await seedInitialPrice(fixture);
    await core.connect(configManager).setAllowedPriceFluctuation(WAD / 10n);

    await submitNav(vault, oracle, settleManager, 120n);
    expect(await vault.isInvalidPrice()).to.equal(true);

    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidPrice);

    await expect(vault.connect(outsider).resetInvalidPrice(100n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await core.setPermissionMask(guardManager.address, MEMBER | CORE_PRICE_GUARD_MANAGER);
    await expect(vault.connect(guardManager).resetInvalidPrice(100n)).to.emit(vault, "InvalidPriceReset");
    expect(await vault.isInvalidPrice()).to.equal(false);
    expect(await vault.lastTokenPrice()).to.equal(WAD);

    await vault.connect(owner).requestDeposit(10n, owner.address, owner.address);
    await submitNav(vault, oracle, settleManager, 100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(10n);
  });

  it("rejects invalid price reset unless the invalid price latch is active", async function () {
    const fixture = await deployFixture();
    const { core, vault, guardManager } = fixture;
    await seedInitialPrice(fixture);
    await core.setPermissionMask(guardManager.address, MEMBER | CORE_PRICE_GUARD_MANAGER);

    await expect(vault.connect(guardManager).resetInvalidPrice(100n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidPrice);
  });

  it("treats zero allowed price fluctuation as disabled", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, settleManager } = fixture;
    await seedInitialPrice(fixture);

    await submitNav(vault, oracle, settleManager, 10_000n);

    expect(await vault.isInvalidPrice()).to.equal(false);
    expect(await vault.lastTokenPrice()).to.equal(100n * WAD);
  });

  it("stores post-performance-fee share price after a valid settlement", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, vaultOwner, owner, settleManager, configManager } = fixture;

    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedInitialPrice(fixture);
    await core.connect(configManager).setAllowedPriceFluctuation(WAD);

    await submitNav(vault, oracle, settleManager, 200n);

    const totalSupply = await vault.totalSupply();
    expect(totalSupply).to.be.gt(100n);
    expect(await vault.lastTokenPrice()).to.equal((200n * WAD) / totalSupply);
  });
});
