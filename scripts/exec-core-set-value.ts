import { getAddress, isAddress } from "ethers";
import { pathToFileURL } from "node:url";
import { connectWithRole, waitAndLog } from "./helpers/exec-helpers.js";

const UINT32_MAX = (1n << 32n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;

type PendingTransaction = {
  hash: string;
  wait: () => Promise<{ status?: number | null }>;
};

type ValueTokenCore = {
  setValueTokenConfig: (
    asset: string,
    feed: string,
    maxPriceAge: bigint,
    minPrice: bigint,
    maxPrice: bigint,
  ) => Promise<PendingTransaction>;
  clearValueTokenConfig: (asset: string) => Promise<PendingTransaction>;
};

export type SetValueTokenCommand =
  | {
      coreAddress: string;
      asset: string;
      clear: true;
    }
  | {
      coreAddress: string;
      asset: string;
      clear: false;
      feed: string;
      maxPriceAge: bigint;
      minPrice: bigint;
      maxPrice: bigint;
    };

export function parseSetValueTokenArguments(args: string[]): SetValueTokenCommand {
  const coreAddress = requiredAddress(args, "--core");
  const asset = requiredAddress(args, "--asset");

  if (args.includes("--clear")) {
    return { coreAddress, asset, clear: true };
  }

  const feed = requiredAddress(args, "--feed");
  const maxPriceAge = parseUnsignedInteger(args, "--max-age", UINT32_MAX);
  const minPrice = parseUnsignedInteger(args, "--min-price", UINT96_MAX);
  const maxPrice = parseUnsignedInteger(args, "--max-price", UINT96_MAX);
  if (minPrice > maxPrice) {
    throw new Error("--min-price must be less than or equal to --max-price");
  }

  return { coreAddress, asset, clear: false, feed, maxPriceAge, minPrice, maxPrice };
}

export async function executeSetValueToken(
  command: SetValueTokenCommand,
  core: ValueTokenCore,
  waitForTransaction: (tx: PendingTransaction) => Promise<void> = waitAndLog,
): Promise<void> {
  if (command.clear) {
    await waitForTransaction(await core.clearValueTokenConfig(command.asset));
    console.log(`cleared value token pricing: ${command.asset}`);
    return;
  }

  await waitForTransaction(
    await core.setValueTokenConfig(
      command.asset,
      command.feed,
      command.maxPriceAge,
      command.minPrice,
      command.maxPrice,
    ),
  );
  console.log(`asset: ${command.asset}`);
  console.log(`feed: ${command.feed}`);
  console.log(`maxPriceAge: ${command.maxPriceAge}`);
  console.log(`minPrice: ${command.minPrice}`);
  console.log(`maxPrice: ${command.maxPrice}`);
}

async function main(): Promise<void> {
  const command = parseSetValueTokenArguments(process.argv.slice(2));
  const { ethers } = await connectWithRole("PK_UFARM_OWNER");
  const core = await ethers.getContractAt("UFarmCore", command.coreAddress);
  await executeSetValueToken(command, core);
}

function requiredValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredAddress(args: string[], name: string): string {
  const value = requiredValue(args, name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be an address`);
  }
  return getAddress(value);
}

function parseUnsignedInteger(args: string[], name: string, maximum: bigint): bigint {
  const value = requiredValue(args, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer`);
  }

  const parsed = BigInt(value);
  if (parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
