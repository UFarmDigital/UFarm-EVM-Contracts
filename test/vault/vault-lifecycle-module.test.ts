import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const LIFECYCLE_MODULE_ID = ethers.id("ufarm.vault.module.lifecycle");
const RequestState = { NoBatch: 4n };

async function deployCoreWithoutLifecycleModule(authority: any) {
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

async function createVault(
  core: any,
  asset: any,
  registrar: any,
  curatorOwner: any,
  vaultOwner: any,
  saltLabel: string,
) {
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id(`${saltLabel}-curator`));
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
      ethers.id(`${saltLabel}-vault`),
      vaultOwner.address,
      "Lifecycle Vault",
      "uLIFE",
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

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, settleManager] = await ethers.getSigners();
  const { core, escrowProxy, lifecycleModule } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner, "lifecycle-module");

  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, VAULT_SETTLE_MANAGER);
  await asset.mint(owner.address, 1_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000n);

  return { core, escrow, vault, oracle, asset, lifecycleModule, owner, settleManager };
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

describe("VaultLifecycleModule", function () {
  it("is deployed and registered by the shared core helper", async function () {
    const { core, lifecycleModule } = await deployFixture();

    expect(await core.vaultModule(LIFECYCLE_MODULE_ID)).to.equal(await lifecycleModule.getAddress());
  });

  it("routes request, oracle settlement, and claim execution through the registered module", async function () {
    const { escrow, vault, oracle, asset, owner, settleManager } = await deployFixture();

    await expect(vault.connect(owner).requestDeposit(100n, owner.address, owner.address))
      .to.emit(vault, "DepositRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 100n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);

    await expect(vault.connect(settleManager).getFunction("settleRequests()")()).to.emit(vault, "OracleRequestStarted");
    const requestId = await vault.activeOracleRequestId();

    await expect(oracle.submitNav(requestId, 100n, await nextBlockTimestamp()))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, await asset.getAddress(), 100n, 100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);

    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.emit(vault, "DepositClaimed")
      .withArgs(owner.address, 100n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
  });

  it("routes lifecycle validation failures through the registered module", async function () {
    const { vault, owner } = await deployFixture();

    await expect(vault.connect(owner).requestRedeem(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    await expect(vault.connect(owner).redeem(0n, ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
    await expect(vault.connect(owner).requestDeposit(1n, ethers.ZeroAddress, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("reverts direct external module calls with ModuleDelegateCallOnly", async function () {
    const module = await ethers.deployContract("VaultLifecycleModule");
    const requestDepositWithVerification = module.getFunction(
      "requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))",
    );
    const signedSettleRequests = module.getFunction(
      "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])",
    );

    await expect(module.requestDeposit(1n, ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(
      requestDepositWithVerification(ethers.ZeroAddress, 1n, ethers.ZeroAddress, ethers.ZeroAddress, {
        signature: "0x",
        validTill: 0n,
        tier: 0n,
      }),
    ).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.deposit(0n, ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.requestRedeem(1n, ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.redeem(0n, ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.cancelDeposit(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.cancelRedeem(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(signedSettleRequests([], [])).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.onOracleNav(1n, 1n, 1n)).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.resetRequests()).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.manualResendOracleRequest()).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
  });

  it("reverts the vault router path with InvalidModule when lifecycle module is unset", async function () {
    const [authority, registrar, curatorOwner, vaultOwner, owner] = await ethers.getSigners();
    const { core } = await deployCoreWithoutLifecycleModule(authority);
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner, "missing-lifecycle-module");

    await asset.mint(owner.address, 100n);
    await asset.connect(owner).approve(await vault.escrow(), 100n);

    await expect(vault.connect(owner).requestDeposit(100n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidModule",
    );
  });
});
