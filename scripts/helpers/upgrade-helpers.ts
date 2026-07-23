import { keccak256 } from "ethers";

export const UPGRADE_TARGETS = ["core", "escrow", "oracle", "curator", "vault", "guard", "adapters"] as const;

export type UpgradeTarget = (typeof UPGRADE_TARGETS)[number];

export type ImmutableReference = {
  start: number;
  length: number;
};

export type ImmutableReferences = Record<string, ImmutableReference[]>;

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
