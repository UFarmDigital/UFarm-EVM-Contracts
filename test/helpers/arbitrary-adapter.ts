import { network } from "hardhat";
import { deployConfiguredCore } from "./deploy-core";
import { configureValueToken } from "./value-token";

export const { ethers } = await network.create();

export const CORE_ADAPTER_MANAGER = 1n << 3n;
export const VAULT_ASSET_MANAGER = 1n;

export const TYPE_WILDCARD_WORDS = 0;
export const TYPE_ANY = 1;
export const TYPE_SELF = 2;
export const TYPE_FROM_LIST = 3;
export const TYPE_EXACT = 4;
export const TYPE_WILDCARD_BYTES = 5;

export const OPCODE_DOMAIN = ethers.toBeHex(0, 1);
export const OPCODE_BEGIN_STRUCT = ethers.toBeHex(1, 1);
export const OPCODE_FIELD = ethers.toBeHex(2, 1);
export const OPCODE_END_STRUCT = ethers.toBeHex(3, 1);
export const OPCODE_BEGIN_ARRAY = ethers.toBeHex(4, 1);
export const OPCODE_END_ARRAY = ethers.toBeHex(5, 1);

export type DirectiveSegment = {
  typ: number;
  span: number;
  data?: string;
};

export function encodeDirective(segments: DirectiveSegment[]) {
  const parts: string[] = [];
  for (const segment of segments) {
    const header = (segment.typ << 5) | (segment.span - 1);
    parts.push(ethers.toBeHex(header, 1));
    if (segment.typ === TYPE_EXACT) {
      if (segment.data === undefined) throw new Error("TYPE_EXACT requires data");
      parts.push(segment.data);
    }
  }
  return ethers.concat(parts);
}

export function selector(signature: string) {
  return ethers.id(signature).slice(0, 10);
}

export function exactSelectorDirective(methodSelector: string) {
  return encodeDirective([{ typ: TYPE_EXACT, span: 4, data: methodSelector }]);
}

export function exactSelectorThenAny(methodSelector: string) {
  return encodeDirective([
    { typ: TYPE_EXACT, span: 4, data: methodSelector },
    { typ: TYPE_ANY, span: 1 },
  ]);
}

export function createCalldata(methodSelector: string, args: string[] = []) {
  return ethers.concat([methodSelector, ...args.map((arg) => ethers.zeroPadValue(arg, 32))]);
}

export function addressWord(address: string) {
  return ethers.zeroPadValue(address, 32);
}

export function uintWord(value: bigint | number | string) {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

export function randomHex(length: number) {
  return ethers.hexlify(ethers.randomBytes(length));
}

export async function deployGuardFixture() {
  const [authority, manager, outsider, user, other, target] = await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, authority);
  await core.setPermissionMask(manager.address, (1n << 253n) | CORE_ADAPTER_MANAGER);
  const guard = await ethers.deployContract("ArbitraryAdapterGuard", [await core.getAddress()]);

  return { core, guard, authority, manager, outsider, user, other, target };
}

export async function deployAdapterFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, assetManager, outsider] = await ethers.getSigners();

  const { core } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("arbitrary-curator"));
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
    .createVault(ethers.id("arbitrary-vault"), vaultOwner.address, "Arbitrary Vault", "uARB", await asset.getAddress());
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
  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, (1n << 253n) | VAULT_ASSET_MANAGER);

  const guard = await ethers.deployContract("ArbitraryAdapterGuard", [await core.getAddress()]);
  const adapter = await ethers.deployContract("ArbitraryAdapter", [await guard.getAddress()]);
  const targetDapp = await ethers.deployContract("MockArbitraryDapp");
  const otherDapp = await ethers.deployContract("MockArbitraryDapp");
  const adapterId = ethers.id("ufarm.adapter.arbitrary");
  await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

  return {
    core,
    curator,
    vault,
    asset,
    guard,
    adapter,
    targetDapp,
    otherDapp,
    adapterId,
    authority,
    vaultOwner,
    assetManager,
    outsider,
  };
}
