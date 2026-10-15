import { getAddress, isAddress, keccak256, ZeroAddress } from "ethers";

export const UPGRADE_TARGETS = [
  "core",
  "escrow",
  "oracle",
  "batch-oracle",
  "curator",
  "vault",
  "guard",
  "adapters",
] as const;

export type UpgradeTarget = (typeof UPGRADE_TARGETS)[number];

export type ImmutableReference = {
  start: number;
  length: number;
};

export type ImmutableReferences = Record<string, ImmutableReference[]>;

type BatchOracleProbe = {
  core: () => Promise<string>;
  requestOraclePool: () => Promise<string>;
  gasLimit: () => Promise<bigint>;
};

export async function validateBatchOracleProxy(
  oracle: BatchOracleProbe,
  expectedCore: string,
  proxyAddress: string,
): Promise<void> {
  let core: string;
  let requestOraclePool: string;
  let gasLimit: bigint;
  try {
    [core, requestOraclePool, gasLimit] = await Promise.all([
      oracle.core(),
      oracle.requestOraclePool(),
      oracle.gasLimit(),
    ]);
  } catch {
    throw new Error(
      `Cannot validate batch oracle proxy ${proxyAddress}: core(), requestOraclePool(), or gasLimit() call failed`,
    );
  }

  if (!isAddress(core)) throw new Error(`Batch oracle proxy ${proxyAddress} has invalid core()`);
  if (getAddress(core) !== getAddress(expectedCore)) {
    throw new Error(`Batch oracle proxy ${proxyAddress} belongs to core ${core}; expected ${expectedCore}`);
  }
  if (!isAddress(requestOraclePool) || getAddress(requestOraclePool) === ZeroAddress) {
    throw new Error(`Batch oracle proxy ${proxyAddress} has invalid requestOraclePool()`);
  }
  if (gasLimit === 0n) throw new Error(`Batch oracle proxy ${proxyAddress} has invalid gasLimit()`);
}

export function parseUpgradeTargets(rawTargets: string | undefined): UpgradeTarget[] {
  if (rawTargets === undefined || rawTargets.trim().length === 0 || rawTargets.trim() === "all") {
    return [...UPGRADE_TARGETS];
  }

  const targets: UpgradeTarget[] = [];
  for (const rawTarget of rawTargets.split(",")) {
    const target = rawTarget.trim();
    if (target.length === 0) continue;
    if (!isUpgradeTarget(target)) {
      throw new Error(`Unknown upgrade target: ${target}`);
    }
    if (!targets.includes(target)) {
      targets.push(target);
    }
  }
  return targets;
}

export function normalizeDeployedBytecode(bytecode: string, immutableReferences: ImmutableReferences = {}): string {
  if (!bytecode.startsWith("0x")) {
    throw new Error("bytecode must be hex-prefixed");
  }

  const bytes = bytecode.slice(2).toLowerCase().split("");
  for (const references of Object.values(immutableReferences)) {
    for (const reference of references) {
      const start = reference.start * 2;
      const end = start + reference.length * 2;
      for (let i = start; i < end; ++i) {
        bytes[i] = "0";
      }
    }
  }

  return `0x${bytes.join("")}`;
}

export function normalizedBytecodeHash(bytecode: string, immutableReferences: ImmutableReferences = {}): string {
  return keccak256(normalizeDeployedBytecode(bytecode, immutableReferences));
}

function isUpgradeTarget(target: string): target is UpgradeTarget {
  return (UPGRADE_TARGETS as readonly string[]).includes(target);
}
