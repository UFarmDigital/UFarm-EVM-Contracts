import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

const OWNER = 1n << 255n;
const FULL_PERMISSION_MASK = (1n << 256n) - 1n;

async function deployCore() {
  const [bootstrap, unauthorized, timelock, curatorLike] = await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, bootstrap);
  return { core, bootstrap, unauthorized, timelock, curatorLike };
}

describe("UFarmCore upgrades and beacons", function () {
  it("allows bootstrap upgrade before handoff and blocks bootstrap after handoff", async function () {
    const { core, bootstrap, unauthorized, timelock } = await deployCore();
    const v2 = await ethers.deployContract("UFarmCoreV2Mock");

    await expect(core.connect(unauthorized).upgradeToAndCall(await v2.getAddress(), "0x"))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(unauthorized.address);

    await core.upgradeToAndCall(await v2.getAddress(), "0x");
    const upgraded = await ethers.getContractAt("UFarmCoreV2Mock", await core.getAddress());
    expect(await upgraded.version()).to.equal("2");

    await upgraded.setPermissionMask(timelock.address, FULL_PERMISSION_MASK);
    await upgraded.setPermissionMask(bootstrap.address, 0n);
    const v2b = await ethers.deployContract("UFarmCoreV2Mock");
    await expect(upgraded.upgradeToAndCall(await v2b.getAddress(), "0x")).to.be.revertedWithCustomError(
      upgraded,
      "Unauthorized",
    );
    await upgraded.connect(timelock).upgradeToAndCall(await v2b.getAddress(), "0x");
  });

  it("sets beacon owner to bootstrap owner and rejects curator-owned upgrades", async function () {
    const { bootstrap, curatorLike } = await deployCore();
    const curatorImpl = await ethers.deployContract("PlaceholderCurator");
    const beacon = await ethers.deployContract("UpgradeableBeacon", [
      await curatorImpl.getAddress(),
      bootstrap.address,
    ]);
    const newCuratorImpl = await ethers.deployContract("PlaceholderCurator");

    expect(await beacon.owner()).to.equal(bootstrap.address);
    await expect(beacon.connect(curatorLike).upgradeTo(await newCuratorImpl.getAddress())).to.be.revert(ethers);
  });
});
