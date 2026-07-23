import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n << 0n;
const VAULT_ASSET_MANAGER = 1n << 0n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const ADAPTER_GATEWAY_MODULE_ID = ethers.id("ufarm.vault.module.adapter-gateway");
const ARBITRARY_ADAPTER_ID = ethers.id("ufarm.adapter.arbitrary");

const SettlementAction = {
  None: 0n,
  Lock: 3n,
};

async function deployCoreWithoutAdapterGatewayModule(authority: any) {
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

  return { core, escrowProxy };
}

async function createVault(core: any, asset: any, registrar: any, curatorOwner: any, vaultOwner: any) {
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("adapter-gateway-curator"));
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
      ethers.id("adapter-gateway-vault"),
      vaultOwner.address,
      "Adapter Gateway Vault",
      "uAGW",
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
  const [authority, registrar, curatorOwner, vaultOwner, assetManager, outsider] = await ethers.getSigners();
  const { core, adapterGatewayModule } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const adapter = await ethers.deployContract("MockVaultAdapter", [ARBITRARY_ADAPTER_ID]);
  const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner);

  await vault
    .connect(vaultOwner)
    .setPermissionMask(assetManager.address, MEMBER | VAULT_ASSET_MANAGER | VAULT_SETTLE_MANAGER);

  return { core, vault, asset, adapter, adapterGatewayModule, assetManager, outsider };
}

describe("VaultAdapterGatewayModule", function () {
  it("is deployed and registered by the shared core helper", async function () {
    const { core, adapterGatewayModule } = await deployFixture();

    expect(await core.vaultModule(ADAPTER_GATEWAY_MODULE_ID)).to.equal(await adapterGatewayModule.getAddress());
  });

  it("routes executeAdapter through the registered module and preserves adapter behavior", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MODULE_EXECUTE");
    const callData = adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Lock]);

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData))
      .to.emit(vault, "AdapterExecuted")
      .withArgs(adapterId);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("keeps signature state in vault storage through sign and revoke", async function () {
    const { core, vault, adapter, assetManager, outsider } = await deployFixture();
    await core.setVaultAdapter(ARBITRARY_ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());
    const digest = ethers.keccak256(ethers.toUtf8Bytes("MOCK_SIGNING_DIGEST"));
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [outsider.address, await vault.getAddress(), "0x"],
    );

    await vault.connect(assetManager).signMessage(ethers.id("DAPP"), message);
    expect(await vault.signedMessages(digest)).to.equal(true);

    await vault.connect(assetManager).revokeSignedMessage(digest);
    expect(await vault.signedMessages(digest)).to.equal(false);
  });

  it("reverts direct external module calls with ModuleDelegateCallOnly", async function () {
    const module = await ethers.deployContract("VaultAdapterGatewayModule");
    const message = {
      messageId: ethers.ZeroHash,
      sourceChainSelector: 1n,
      sender: "0x",
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(module.executeAdapter(ethers.id("DIRECT"), "0x")).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.ccipReceive(message)).to.be.revertedWithCustomError(module, "ModuleDelegateCallOnly");
    await expect(module.signMessage(ethers.id("DAPP"), "0x")).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
    await expect(module.revokeSignedMessage(ethers.ZeroHash)).to.be.revertedWithCustomError(
      module,
      "ModuleDelegateCallOnly",
    );
  });

  it("reverts the vault router path with InvalidModule when adapter gateway module is unset", async function () {
    const [authority, registrar, curatorOwner, vaultOwner, assetManager] = await ethers.getSigners();
    const { core } = await deployCoreWithoutAdapterGatewayModule(authority);
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const vault = await createVault(core, asset, registrar, curatorOwner, vaultOwner);

    await vault.connect(vaultOwner).setPermissionMask(assetManager.address, MEMBER | VAULT_ASSET_MANAGER);

    await expect(
      vault.connect(assetManager).executeAdapter(ethers.id("UNSET_MODULE"), "0x"),
    ).to.be.revertedWithCustomError(vault, "InvalidModule");
  });
});
