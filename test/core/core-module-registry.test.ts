import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const ADAPTER_GATEWAY_MODULE_ID = ethers.id("ufarm.vault.module.adapter-gateway");

async function deployFixture() {
  const [authority, configManager, moduleManager, noPermission] = await ethers.getSigners();
  const coreImpl = await ethers.deployContract("UFarmCore");
  const initData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
  const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), initData]);
  const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());
  const moduleA = await ethers.deployContract("MockVaultModule");
  const moduleB = await ethers.deployContract("MockVaultModule");

  return { core, authority, configManager, moduleManager, noPermission, moduleA, moduleB };
}

describe("UFarmCore module registry", function () {
  it("lets the initial full-permission authority set and replace a vault module", async function () {
    const { core, moduleA, moduleB } = await deployFixture();
    const moduleAAddress = await moduleA.getAddress();
    const moduleBAddress = await moduleB.getAddress();

    await expect(core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, moduleAAddress))
      .to.emit(core, "VaultModuleUpdated")
      .withArgs(ADAPTER_GATEWAY_MODULE_ID, moduleAAddress);
    expect(await core.vaultModule(ADAPTER_GATEWAY_MODULE_ID)).to.equal(moduleAAddress);

    await expect(core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, moduleBAddress))
      .to.emit(core, "VaultModuleUpdated")
      .withArgs(ADAPTER_GATEWAY_MODULE_ID, moduleBAddress);
    expect(await core.vaultModule(ADAPTER_GATEWAY_MODULE_ID)).to.equal(moduleBAddress);
  });

  it("does not let a core config manager update vault modules", async function () {
    const { core, configManager, moduleA } = await deployFixture();
    await core.setPermissionMask(configManager.address, MEMBER | CORE_CONFIG_MANAGER);

    await expect(core.connect(configManager).setVaultModule(ADAPTER_GATEWAY_MODULE_ID, await moduleA.getAddress()))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(configManager.address);
  });

  it("does not let a dedicated core module manager update vault modules", async function () {
    const { core, moduleManager, moduleA } = await deployFixture();
    const moduleAddress = await moduleA.getAddress();
    await core.setPermissionMask(moduleManager.address, MEMBER);

    await expect(core.connect(moduleManager).setVaultModule(ADAPTER_GATEWAY_MODULE_ID, moduleAddress))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(moduleManager.address);
    expect(await core.vaultModule(ADAPTER_GATEWAY_MODULE_ID)).to.equal(ethers.ZeroAddress);
  });

  it("rejects invalid module ids and module addresses", async function () {
    const { core, noPermission, moduleA } = await deployFixture();

    await expect(core.setVaultModule(ethers.ZeroHash, await moduleA.getAddress())).to.be.revertedWithCustomError(
      core,
      "InvalidConfig",
    );
    await expect(core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );
    await expect(core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, noPermission.address)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );
  });
});
