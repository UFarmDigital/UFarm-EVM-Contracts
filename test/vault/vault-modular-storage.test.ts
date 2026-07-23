import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create({ override: { allowUnlimitedContractSize: true } });

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;

const SLOT_NAMES = [
  ["baseSlot", "ufarm.vault.base.storage"],
  ["permissionSlot", "ufarm.vault.permission.storage"],
  ["lifecycleSlot", "ufarm.vault.lifecycle.storage"],
  ["configSlot", "ufarm.vault.config.storage"],
  ["crossChainSlot", "ufarm.vault.crosschain.adapter.storage"],
] as const;

async function deployVaultFixture() {
  const [authority, registrar, curatorOwner, vaultOwner] = await ethers.getSigners();
  const name = "UFarm Modular Vault";
  const symbol = "uMOD";

  const { core } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await core.setPermissionMask(registrar.address, MEMBER | CORE_CURATOR_REGISTRAR);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("modular-curator"));
  const curatorReceipt = await curatorTx.wait();
  const curatorEvent = curatorReceipt?.logs
    .map((log) => {
      try {
        return core.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CuratorCreated");
  const curator = await ethers.getContractAt("UFarmCurator", curatorEvent!.args.curator as string);

  const vaultTx = await curator
    .connect(curatorOwner)
    .createVault(ethers.id("modular-vault"), vaultOwner.address, name, symbol, await asset.getAddress());
  const vaultReceipt = await vaultTx.wait();
  const vaultEvent = vaultReceipt?.logs
    .map((log) => {
      try {
        return curator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "VaultCreated");
  const vault = await ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);

  return { core, curator, vault, asset, name, symbol };
}

describe("Vault modular storage", function () {
  it("uses explicit nonzero, unique namespace slots", async function () {
    const harness = await ethers.deployContract("VaultStorageSlotsHarness");
    const slots: string[] = [];

    for (const [method, slotName] of SLOT_NAMES) {
      const slot = await harness[method]();
      expect(slot).to.equal(ethers.keccak256(ethers.toUtf8Bytes(slotName)));
      expect(slot).to.not.equal(ethers.ZeroHash);
      slots.push(slot);
    }

    expect(new Set(slots).size).to.equal(slots.length);
  });

  it("keeps vault deployment and metadata reads working with namespaced storage", async function () {
    const { core, curator, vault, asset, name, symbol } = await deployVaultFixture();

    expect(await vault.core()).to.equal(await core.getAddress());
    expect(await vault.curator()).to.equal(await curator.getAddress());
    expect(await vault.name()).to.equal(name);
    expect(await vault.symbol()).to.equal(symbol);
    expect(await vault.asset()).to.equal(await asset.getAddress());
    expect(await vault.totalSupply()).to.equal(0n);
    expect(await vault.clientTier()).to.equal(0n);
    expect(await vault.transferRestricted()).to.equal(false);
  });
});
