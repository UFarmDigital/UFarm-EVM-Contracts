import "dotenv/config";
import { getAddress, id, isAddress, isHexString, parseUnits } from "ethers";
import { configVariable } from "hardhat/config";

type ExecConnection = Awaited<ReturnType<typeof import("hardhat").network.create>> & {
  // The ethers plugin augments Hardhat network connections at runtime, but its
  // type augmentation is only visible when scripts are loaded through Hardhat.
  ethers: any;
};

const READ_ONLY_PRIVATE_KEY = "0x59c6995e998f97a5a0044976f0e6e9203c36e30eb3b6fdd54cf1123149f9d5";

export type RolePrivateKey = "PK_UFARM_OWNER" | "PK_VAULT_OWNER" | "PK_INVESTOR";

export function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;

  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

export function optionalAddressArgument(name: string, fallback: string): string {
  const value = argumentValue(name) ?? fallback;
  return requireAddressValue(name, value);
}

export function optionalAddressArgumentValue(name: string): string | undefined {
  const value = argumentValue(name);
  return value === undefined ? undefined : requireAddressValue(name, value);
}

export function requiredAddressArgument(name: string): string {
  return requireAddressValue(name, requiredArgument(name));
}

export function requiredArgument(name: string): string {
  const value = argumentValue(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function optionalUintArgument(name: string, fallback: bigint): bigint {
  const value = argumentValue(name);
  return value === undefined ? fallback : parseBigInt(name, value);
}

export function requiredUintArgument(name: string): bigint {
  return parseBigInt(name, requiredArgument(name));
}

export function optionalBytesArgument(name: string, fallback = "0x"): string {
  const value = argumentValue(name) ?? fallback;
  if (!isHexString(value)) {
    throw new Error(`${name} must be hex bytes`);
  }
  return value;
}

export function parseSaltArgument(name = "--salt"): string {
  const value = requiredArgument(name);
  if (isHexString(value, 32)) return value;
  return id(value);
}

export function parseTokenAmountArgument(name: string, decimals = 18): bigint {
  const value = requiredArgument(name);
  return value.includes(".") ? parseUnits(value, decimals) : parseBigInt(name, value);
}

export async function connectReadOnly(): Promise<ExecConnection> {
  process.env.UFARM_PRIVATE_KEY ??=
    process.env.PK_INVESTOR ?? process.env.PK_UFARM_OWNER ?? process.env.PK_VAULT_OWNER ?? READ_ONLY_PRIVATE_KEY;

  const { network } = await import("hardhat");
  return network.create("ufarm") as Promise<ExecConnection>;
}

export async function connectWithRole(role: RolePrivateKey): Promise<ExecConnection> {
  const { network } = await import("hardhat");
  return network.create({
    network: "ufarm",
    override: { accounts: [resolveRoleAccount(role)] },
  }) as Promise<ExecConnection>;
}

export function resolveRoleAccount(role: RolePrivateKey) {
  return process.env[role] || configVariable(role);
}

export async function waitAndLog(tx: { hash: string; wait: () => Promise<{ status?: number | null }> }): Promise<void> {
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`status: ${receipt.status ?? "unknown"}`);
}

function parseBigInt(name: string, value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
}

function requireAddressValue(name: string, value: string): string {
  if (!isAddress(value)) {
    throw new Error(`${name} must be an address`);
  }
  return getAddress(value);
}
