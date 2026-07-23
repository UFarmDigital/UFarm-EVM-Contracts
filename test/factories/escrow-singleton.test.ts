import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

async function deployEscrow(core: string) {
  const impl = await ethers.deployContract("UFarmEscrow");
  const initData = impl.interface.encodeFunctionData("initialize", [core]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), initData]);
  return {
    impl,
    escrow: await ethers.getContractAt("UFarmEscrow", await proxy.getAddress()),
  };
}

describe("UFarmEscrow singleton", function () {
  it("initializes with core and rejects zero core", async function () {
    const core = ethers.getAddress("0x0000000000000000000000000000000000000C01");
    const { escrow } = await deployEscrow(core);

    expect(await escrow.core()).to.equal(core);

    const impl = await ethers.deployContract("UFarmEscrow");
    const initData = impl.interface.encodeFunctionData("initialize", [ethers.ZeroAddress]);
    await expect(
      ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), initData]),
    ).to.be.revertedWithCustomError(impl, "InvalidAddress");
  });

  it("disables implementation initialization", async function () {
    const impl = await ethers.deployContract("UFarmEscrow");
    await expect(
      impl.initialize(ethers.getAddress("0x0000000000000000000000000000000000000C01")),
    ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });

  it("authorizes upgrades only through core owner permission", async function () {
    const [authority, other] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);

    const { escrow } = await deployEscrow(await core.getAddress());
    const newImpl = await ethers.deployContract("UFarmEscrow");

    await expect(escrow.connect(other).upgradeToAndCall(await newImpl.getAddress(), "0x"))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(other.address);
  });

  it("allows core owner to upgrade and preserves core", async function () {
    const [authority] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);

    const coreAddress = await core.getAddress();
    const { escrow } = await deployEscrow(coreAddress);
    const newImpl = await ethers.deployContract("UFarmEscrow");

    await escrow.connect(authority).upgradeToAndCall(await newImpl.getAddress(), "0x");
    expect(await escrow.core()).to.equal(coreAddress);
  });

  it("rejects reinitialization on proxy", async function () {
    const core = ethers.getAddress("0x0000000000000000000000000000000000000C01");
    const { escrow } = await deployEscrow(core);

    await expect(escrow.initialize(core)).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
  });
});
