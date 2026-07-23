import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

const OWNER = 1n << 255n;
const ADMIN = 1n << 254n;
const FULL_PERMISSION_MASK = (1n << 256n) - 1n;

async function deployFixture() {
  const [authority, registrar, curatorOwner, otherOwner, outsider] = await ethers.getSigners();

  const { core, createX } = await deployConfiguredCore(ethers, authority);
  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);

  return { core, registrar, curatorOwner, otherOwner, outsider, authority, createX };
}

describe("UFarmCore curator factory", function () {
  it("rejects invalid curator proxy initialization arguments", async function () {
    const [, , curatorOwner] = await ethers.getSigners();
    const impl = await ethers.deployContract("UFarmCurator");

    await expect(
      ethers.deployContract("ERC1967Proxy", [
        await impl.getAddress(),
        impl.interface.encodeFunctionData("initialize", [
          ethers.ZeroAddress,
          curatorOwner.address,
          ethers.id("bad-core"),
        ]),
      ]),
    ).to.be.revertedWithCustomError(impl, "InvalidAddress");

    await expect(
      ethers.deployContract("ERC1967Proxy", [
        await impl.getAddress(),
        impl.interface.encodeFunctionData("initialize", [
          curatorOwner.address,
          ethers.ZeroAddress,
          ethers.id("bad-owner"),
        ]),
      ]),
    ).to.be.revertedWithCustomError(impl, "InvalidAddress");
  });

  it("creates a curator BeaconProxy for authorized registrar", async function () {
    const { core, registrar, curatorOwner } = await deployFixture();
    const userSalt = ethers.id("salt-1");
    const predicted = await core.connect(registrar).createCurator.staticCall(curatorOwner.address, userSalt);

    const tx = await core.connect(registrar).createCurator(curatorOwner.address, userSalt);
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log) => {
        try {
          return core.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "CuratorCreated");

    expect(event).to.not.equal(undefined);
    const curator = event!.args.curator as string;
    const logicalSalt = event!.args.logicalSalt as string;
    expect(predicted).to.equal(curator);

    expect(await core.isCurator(curator)).to.equal(true);

    const curatorContract = await ethers.getContractAt("UFarmCurator", curator);
    expect(await curatorContract.core()).to.equal(await core.getAddress());
    expect(await curatorContract.permissionMask(curatorOwner.address)).to.equal(FULL_PERMISSION_MASK);
    expect(await curatorContract.accountHasPermission(curatorOwner.address, OWNER)).to.equal(true);
    expect(await curatorContract.accountHasPermission(curatorOwner.address, OWNER | 1n)).to.equal(true);
    expect(await curatorContract.accountHasAnyPermission(curatorOwner.address, OWNER | 1n)).to.equal(true);
    expect(await curatorContract.curatorSalt()).to.equal(logicalSalt);
  });

  it("allows curator admins to update permissions except the owner flag", async function () {
    const { core, registrar, curatorOwner } = await deployFixture();
    const [, , , admin, target, outsider] = await ethers.getSigners();
    const tx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("curator-admin"));
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log) => {
        try {
          return core.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "CuratorCreated");
    const curator = await ethers.getContractAt("UFarmCurator", event!.args.curator as string);

    await expect(
      curator.connect(curatorOwner).setPermissionMask(ethers.ZeroAddress, ADMIN),
    ).to.be.revertedWithCustomError(curator, "InvalidAddress");

    await expect(curator.connect(outsider).setPermissionMask(target.address, 1n))
      .to.be.revertedWithCustomError(curator, "Unauthorized")
      .withArgs(outsider.address);

    await curator.connect(curatorOwner).setPermissionMask(admin.address, ADMIN);
    await expect(
      curator.connect(admin).setPermissionMask(target.address, await curator.CURATOR_VAULT_CREATOR()),
    ).to.emit(curator, "CuratorPermissionUpdated");
    await expect(curator.connect(admin).setPermissionMask(target.address, OWNER))
      .to.be.revertedWithCustomError(curator, "Unauthorized")
      .withArgs(admin.address);
  });

  it("rejects unauthorized, zero owner, and duplicate salt", async function () {
    const { core, registrar, curatorOwner, outsider, createX } = await deployFixture();
    const userSalt = ethers.id("same");

    await expect(core.connect(outsider).createCurator(curatorOwner.address, userSalt))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(outsider.address);

    await expect(core.connect(registrar).createCurator(ethers.ZeroAddress, userSalt)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );

    await core.connect(registrar).createCurator(curatorOwner.address, userSalt);
    await expect(core.connect(registrar).createCurator(curatorOwner.address, userSalt)).to.be.revertedWithCustomError(
      createX,
      "AlreadyDeployed",
    );
  });

  it("derives different curator addresses for different owners using the same user salt", async function () {
    const { core, registrar, curatorOwner, otherOwner } = await deployFixture();
    const userSalt = ethers.id("same-salt");

    const first = await core.connect(registrar).createCurator.staticCall(curatorOwner.address, userSalt);
    const second = await core.connect(registrar).createCurator.staticCall(otherOwner.address, userSalt);

    expect(first).to.not.equal(second);
  });
});
