import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const VAULT_CONFIG_MANAGER = 1n << 2n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const ADMIN_CONFIG_MODULE_ID = ethers.id("ufarm.vault.module.admin-config");
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;
const MAX_PERFORMANCE_FEE_PERIOD = 366n * 24n * 60n * 60n;

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>, period = 0n) {
  const schedule = steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
  return schedule | (period << 128n);
}

async function deployCoreWithoutAdminConfigModule(authority: any) {
  const coreImpl = await ethers.deployContract("UFarmCore");
  const coreInitData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
  const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), coreInitData]);
  const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());

  const escrowImpl = await ethers.deployContract("UFarmEscrow");
  const escrowInitData = escrowImpl.interface.encodeFunctionData("initialize", [await core.getAddress()]);
  const escrowProxy = await ethers.deployContract("ERC1967Proxy", [await escrowImpl.getAddress(), escrowInitData]);

  const createX = await ethers.deployContract("MockCreateX");
  const curatorImpl = await ethers.deployContract("UFarmCurator");
  const vaultImpl = await ethers.deployContract("UFarmVault");
  const curatorBeacon = await ethers.deployContract("UpgradeableBeacon", [
    await curatorImpl.getAddress(),
    authority.address,
  ]);
  const vaultBeacon = await ethers.deployContract("UpgradeableBeacon", [
    await vaultImpl.getAddress(),
    authority.address,
  ]);

  await core.initializeFactory(
    await escrowProxy.getAddress(),
    await createX.getAddress(),
    await curatorBeacon.getAddress(),
    await vaultBeacon.getAddress(),
  );
  await core.initializeCrossChain(31337n);

  return { core };
}

async function createVault(core: any, asset: any, registrar: any, curatorOwner: any, vaultOwner: any) {
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("admin-config-curator"));
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
      ethers.id("admin-config-vault"),
      vaultOwner.address,
      "Admin Config Vault",
      "uACF",
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

  return ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const vaultAddress = await vault.getAddress();
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  await core.setVaultOracle(vaultAddress, await oracle.getAddress());

  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const latest = await ethers.provider.getBlock("latest");
  return oracle.submitNav(requestId, nav, BigInt(latest!.timestamp + 1));
}

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, configManager, settlementManager, outsider] =
    await ethers.getSigners();
  const { core, adminConfigModule } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner);

  await vault.connect(vaultOwner).setPermissionMask(configManager.address, MEMBER | VAULT_CONFIG_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(settlementManager.address, VAULT_SETTLE_MANAGER);

  return { core, vault, asset, adminConfigModule, vaultOwner, configManager, settlementManager, outsider };
}

describe("VaultAdminConfigModule", function () {
  it("is deployed and registered by the shared core helper", async function () {
    const { core, adminConfigModule } = await deployFixture();

    expect(await core.vaultModule(ADMIN_CONFIG_MODULE_ID)).to.equal(await adminConfigModule.getAddress());
  });

  it("routes fee, investment range, and tier updates through the registered module", async function () {
    const { vault, configManager } = await deployFixture();
    const managementFee = 100_000_000_000_000_000n;
    const performanceFee = packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]], 30n * 24n * 60n * 60n);

    await expect(vault.connect(configManager).setFees(managementFee, performanceFee))
      .to.emit(vault, "VaultFeesUpdated")
      .withArgs(managementFee, performanceFee);
    expect(await vault.fees()).to.deep.equal([managementFee, performanceFee]);

    await expect(vault.connect(configManager).setInvestmentRange(10n, 1_000n))
      .to.emit(vault, "InvestmentRangeUpdated")
      .withArgs(10n, 1_000n);
    expect(await vault.investmentRange()).to.deep.equal([10n, 1_000n]);

    await expect(vault.connect(configManager).setClientTier(2n)).to.emit(vault, "ClientTierUpdated").withArgs(2n);
    expect(await vault.clientTier()).to.equal(2n);
  });

  it("lets the vault config manager restrict direct transfers", async function () {
    const { vault, configManager, outsider } = await deployFixture();

    expect(await vault.transferRestricted()).to.equal(false);
    await expect(vault.connect(outsider).setTransferRestricted(true))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(configManager).setTransferRestricted(true))
      .to.emit(vault, "TransferRestrictionUpdated")
      .withArgs(true);
    expect(await vault.transferRestricted()).to.equal(true);
  });

  it("preserves admin config permissions, caps, and fee lock behavior", async function () {
    const { vault, vaultOwner, configManager, settlementManager, outsider, asset } = await deployFixture();
    const validPerformanceFee = packPerformanceFeeSchedule([[1n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    await expect(vault.connect(outsider).setFees(1n, validPerformanceFee))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(outsider).setInvestmentRange(1n, 2n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(outsider).setClientTier(1n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await expect(vault.connect(configManager).setFees(100_000_000_000_000_001n, 0n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await expect(
      vault.connect(configManager).setFees(0n, packPerformanceFeeSchedule([[5_001n, MAX_PERFORMANCE_THRESHOLD_BPS]])),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(configManager).setFees(0n, packPerformanceFeeSchedule([[1_000n, 1_000n]])),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(configManager).setFees(
        0n,
        packPerformanceFeeSchedule([
          [1_000n, 2_000n],
          [1_000n, 1_500n],
          [1_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
        ]),
      ),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(configManager).setFees(0n, packPerformanceFeeSchedule([], 30n * 24n * 60n * 60n)),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault
        .connect(configManager)
        .setFees(
          0n,
          packPerformanceFeeSchedule([[1_000n, MAX_PERFORMANCE_THRESHOLD_BPS]], MAX_PERFORMANCE_FEE_PERIOD + 1n),
        ),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(vault.connect(configManager).setFees(0n, 1n << 160n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );

    await asset.mint(vaultOwner.address, 100n);
    await asset.connect(vaultOwner).approve(await vault.escrow(), 100n);
    await vault.connect(vaultOwner).requestDeposit(100n, vaultOwner.address, vaultOwner.address);
    await settleWithOracle(vault, settlementManager, 100n);
    await vault.connect(vaultOwner).deposit(0n, vaultOwner.address, vaultOwner.address);

    expect(await vault.totalSupply()).to.equal(100n);
    await expect(vault.connect(configManager).setFees(1n, validPerformanceFee)).to.be.revertedWithCustomError(
      vault,
      "FeeConfigLocked",
    );
  });

  it("reverts direct external module calls with ModuleDelegateCallOnly", async function () {
    const module = await ethers.deployContract("VaultAdminConfigModule");

    await expect(module.setFees(1n, 1n)).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.setInvestmentRange(1n, 2n)).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.setClientTier(1n)).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.setTransferRestricted(true)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.terminate()).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
  });

  it("reverts the vault router path with InvalidModule when admin config module is unset", async function () {
    const [authority, registrar, curatorOwner, vaultOwner, configManager] = await ethers.getSigners();
    const { core } = await deployCoreWithoutAdminConfigModule(authority);
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner);

    await vault.connect(vaultOwner).setPermissionMask(configManager.address, MEMBER | VAULT_CONFIG_MANAGER);

    await expect(vault.connect(configManager).setFees(1n, 1n)).to.be.revertedWithCustomError(vault, "InvalidModule");
    await expect(vault.connect(configManager).setTransferRestricted(true)).to.be.revertedWithCustomError(
      vault,
      "InvalidModule",
    );
    await expect(vault.connect(vaultOwner).terminate()).to.be.revertedWithCustomError(vault, "InvalidModule");
  });
});
