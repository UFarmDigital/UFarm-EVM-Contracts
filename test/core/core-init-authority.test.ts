import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

const OWNER = 1n << 255n;
const FULL_PERMISSION_MASK = (1n << 256n) - 1n;
const CoreConfig = { FactoryNotConfigured: 3n };

describe("UFarmCore initialization and owner permissions", function () {
  async function deployCore() {
    const [bootstrap, unauthorized, timelock] = await ethers.getSigners();
    const { core, coreImpl: impl } = await deployConfiguredCore(ethers, bootstrap);
    return { core, impl, bootstrap, unauthorized, timelock };
  }

  async function deployInitializedCoreOnly(authority: any) {
    const impl = await ethers.deployContract("UFarmCore");
    const initData = impl.interface.encodeFunctionData("initialize", [authority.address]);
    const proxy = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), initData]);
    const core = await ethers.getContractAt("UFarmCore", await proxy.getAddress());
    return { core, impl };
  }

  async function deployFactoryDependencies(authority: any, coreAddress: string) {
    const escrowImpl = await ethers.deployContract("UFarmEscrow");
    const escrowInitData = escrowImpl.interface.encodeFunctionData("initialize", [coreAddress]);
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

    return { escrowProxy, createX, curatorBeacon, vaultBeacon };
  }

  it("rejects zero initial authority", async function () {
    const impl = await ethers.deployContract("UFarmCore");
    await expect(impl.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(impl, "InvalidAddress");
  });

  it("initializes once through the proxy", async function () {
    const { core, bootstrap } = await deployCore();
    expect(await core.permissionMask(bootstrap.address)).to.equal(FULL_PERMISSION_MASK);
    expect(await core.accountHasPermission(bootstrap.address, OWNER)).to.equal(true);
    await expect(core.initialize(bootstrap.address)).to.be.revert(ethers);
  });

  it("rejects invalid factory dependency addresses and escrow core mismatches", async function () {
    const [bootstrap, wrongCore] = await ethers.getSigners();
    const { core } = await deployInitializedCoreOnly(bootstrap);
    const { escrowProxy, createX, curatorBeacon, vaultBeacon } = await deployFactoryDependencies(
      bootstrap,
      await core.getAddress(),
    );

    await expect(
      core.initializeFactory(
        ethers.ZeroAddress,
        await createX.getAddress(),
        await curatorBeacon.getAddress(),
        await vaultBeacon.getAddress(),
      ),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");

    await expect(
      core.initializeFactory(
        bootstrap.address,
        await createX.getAddress(),
        await curatorBeacon.getAddress(),
        await vaultBeacon.getAddress(),
      ),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");

    const mismatched = await deployFactoryDependencies(bootstrap, wrongCore.address);
    await expect(
      core.initializeFactory(
        await mismatched.escrowProxy.getAddress(),
        await createX.getAddress(),
        await curatorBeacon.getAddress(),
        await vaultBeacon.getAddress(),
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");

    await core.initializeFactory(
      await escrowProxy.getAddress(),
      await createX.getAddress(),
      await curatorBeacon.getAddress(),
      await vaultBeacon.getAddress(),
    );

    expect(await core.escrow()).to.equal(await escrowProxy.getAddress());
  });

  it("rejects curator creation before factory dependencies are initialized", async function () {
    const [bootstrap, curatorOwner] = await ethers.getSigners();
    const { core } = await deployInitializedCoreOnly(bootstrap);

    await expect(core.createCurator(curatorOwner.address, ethers.id("factory-not-ready")))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.FactoryNotConfigured);
  });

  it("allows owner permission handoff through permission masks", async function () {
    const { core, bootstrap, unauthorized, timelock } = await deployCore();

    await expect(core.connect(unauthorized).setPermissionMask(timelock.address, OWNER))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(unauthorized.address);

    await expect(core.setPermissionMask(timelock.address, FULL_PERMISSION_MASK))
      .to.emit(core, "PermissionUpdated")
      .withArgs(timelock.address, FULL_PERMISSION_MASK);

    await expect(core.setPermissionMask(bootstrap.address, 0n))
      .to.emit(core, "PermissionUpdated")
      .withArgs(bootstrap.address, 0n);

    await expect(core.setPermissionMask(unauthorized.address, 1n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(bootstrap.address);
    await core.connect(timelock).setPermissionMask(unauthorized.address, 1n);
    expect(await core.permissionMask(unauthorized.address)).to.equal(1n);
  });
});
