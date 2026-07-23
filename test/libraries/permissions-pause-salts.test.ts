import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Foundation libraries", function () {
  it("checks, grants, and revokes permission bits", async function () {
    const harness = await ethers.deployContract("CoreHarness");

    const mask = 0n;
    const granted = await harness.grant(mask, 1n << 3n);
    expect(await harness.hasPermission(granted, 1n << 3n)).to.equal(true);
    expect(await harness.hasPermission(granted, 1n << 4n)).to.equal(false);
    expect(await harness.hasPermission(granted, 0n)).to.equal(false);
    expect(await harness.hasPermission(granted, (1n << 3n) | (1n << 4n))).to.equal(false);
    expect(await harness.hasAnyPermission(granted, (1n << 3n) | (1n << 4n))).to.equal(true);
    expect(await harness.hasAnyPermission(granted, 1n << 4n)).to.equal(false);
    expect(await harness.hasAnyPermission(granted, 0n)).to.equal(false);

    const revoked = await harness.revoke(granted, 1n << 3n);
    expect(await harness.hasPermission(revoked, 1n << 3n)).to.equal(false);

    expect(await harness.member()).to.equal(1n << 253n);
    expect(await harness.admin()).to.equal(1n << 254n);
  });

  it("checks pause bits", async function () {
    const harness = await ethers.deployContract("CoreHarness");

    const fullPause = await harness.fullProtocolPause();
    const mask = fullPause | (await harness.depositRequestsPaused());

    expect(await harness.isPaused(mask, fullPause)).to.equal(true);
    expect(await harness.isPaused(mask, await harness.claimsPaused())).to.equal(false);
  });

  it("derives logical salts and CreateX sender-bound salts", async function () {
    const harness = await ethers.deployContract("CoreHarness");
    const [deployer, other] = await ethers.getSigners();
    const userSalt = ethers.id("user salt");
    const curatorOwner = "0x000000000000000000000000000000000000CAFE";
    const curator = "0x000000000000000000000000000000000000bEEF";

    const curatorSalt = await harness.curatorSalt(curatorOwner, userSalt);
    const vaultSalt = await harness.vaultSalt(curator, userSalt);
    expect(curatorSalt).to.not.equal(vaultSalt);

    const createX = await harness.createXSalt(deployer.address, curatorSalt);
    const createXOther = await harness.createXSalt(other.address, curatorSalt);
    expect(createX).to.not.equal(createXOther);
    expect(createX.slice(0, 42).toLowerCase()).to.equal(deployer.address.toLowerCase());
    expect(createX.slice(42, 44)).to.equal("00");
  });

  it("mock CreateX enforces CreateX guarded salt layout", async function () {
    const [deployer] = await ethers.getSigners();
    const mockCreateX = await ethers.deployContract("MockCreateX");
    const payload = ethers.concat([(await ethers.getContractFactory("PlaceholderCurator")).bytecode, "0x"]);
    const logicalSalt = ethers.id("runtime salt");
    const validSalt = ethers.zeroPadValue(deployer.address, 20) + "00" + logicalSalt.slice(44);
    const unspecifiedFlagSalt = ethers.zeroPadValue(deployer.address, 20) + "02" + logicalSalt.slice(44);
    const invalidSalt = ethers.id("not sender prefixed");

    await expect(mockCreateX.deployCreate3(invalidSalt, payload)).to.be.revertedWithCustomError(
      mockCreateX,
      "InvalidSalt",
    );
    await expect(mockCreateX.deployCreate3(unspecifiedFlagSalt, payload)).to.be.revertedWithCustomError(
      mockCreateX,
      "InvalidSalt",
    );

    await expect(mockCreateX.deployCreate3(validSalt, payload)).to.emit(mockCreateX, "Deployed");

    await expect(mockCreateX.deployCreate3(validSalt, payload)).to.be.revertedWithCustomError(
      mockCreateX,
      "AlreadyDeployed",
    );
  });

  it("harness deployCreate3 uses CoreHarness as guarded salt sender", async function () {
    const harness = await ethers.deployContract("CoreHarness");
    const mockCreateX = await ethers.deployContract("MockCreateX");
    const payload = ethers.concat([(await ethers.getContractFactory("PlaceholderCurator")).bytecode, "0x"]);
    const logicalSalt = ethers.id("harness runtime salt");

    const deployed = await harness.deployCreate3.staticCall(mockCreateX.target, logicalSalt, payload);
    expect(deployed).to.not.equal(ethers.ZeroAddress);

    await expect(harness.deployCreate3(mockCreateX.target, logicalSalt, payload)).to.emit(mockCreateX, "Deployed");

    const deployedCode = await ethers.provider.getCode(deployed);
    expect(deployedCode).to.not.equal("0x");
  });
});
