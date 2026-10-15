import { artifacts } from "hardhat";
import { ZeroAddress, getAddress, id } from "ethers";
import {
  argumentValue,
  connectWithRole,
  optionalAddressArgumentValue,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";
import {
  type ImmutableReferences,
  type UpgradeTarget,
  normalizedBytecodeHash,
  parseUpgradeTargets,
  validateBatchOracleProxy,
} from "./helpers/upgrade-helpers.js";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ARBITRARY_ADAPTER_ID = id("ufarm.adapter.arbitrary");
const CROSS_CHAIN_ADAPTER_ID = id("ufarm.adapter.cross-chain");

type UpgradeConnection = Awaited<ReturnType<typeof connectWithRole>>;

type UpgradeContext = {
  ethers: UpgradeConnection["ethers"];
  core: any;
  coreAddress: string;
  dryRun: boolean;
};

type UpgradeSpec = {
  label: string;
  contractName: string;
  currentAddress: string;
  constructorArgs?: unknown[];
  apply: (newImplementation: string) => Promise<void>;
};

const coreAddress = requiredAddressArgument("--core");
const include = parseUpgradeTargets(argumentValue("--include"));
const guardOverride = optionalAddressArgumentValue("--guard");
const batchOracleOverride = optionalAddressArgumentValue("--batch-oracle");
const dryRun = process.argv.includes("--dry-run");

const connection = await connectWithRole("PK_UFARM_OWNER");
const { ethers } = connection;
const core = await ethers.getContractAt("UFarmCore", coreAddress);

console.log(`core: ${coreAddress}`);
console.log(`include: ${include.join(",")}`);
if (dryRun) console.log("dry run: no deployments or upgrade calls will be sent");

const context: UpgradeContext = { ethers, core, coreAddress, dryRun };

for (const target of include) {
  await upgradeTarget(context, target, guardOverride, batchOracleOverride);
}

async function upgradeTarget(
  context: UpgradeContext,
  target: UpgradeTarget,
  guardAddress?: string,
  batchOracleAddress?: string,
): Promise<void> {
  if (target === "core") {
    await upgradeUUPS(context, {
      label: "core",
      contractName: "UFarmCore",
      currentAddress: await implementationOf(context, context.coreAddress),
      apply: async (newImplementation) => {
        const coreProxy = await context.ethers.getContractAt("UFarmCore", context.coreAddress);
        await waitAndLog(await coreProxy.upgradeToAndCall(newImplementation, "0x"));
      },
    });
    return;
  }

  if (target === "escrow") {
    const escrow = await context.core.escrow();
    await upgradeUUPS(context, {
      label: "escrow",
      contractName: "UFarmEscrow",
      currentAddress: await implementationOf(context, escrow),
      apply: async (newImplementation) => {
        const escrowProxy = await context.ethers.getContractAt("UFarmEscrow", escrow);
        await waitAndLog(await escrowProxy.upgradeToAndCall(newImplementation, "0x"));
      },
    });
    return;
  }

  if (target === "oracle") {
    const oracle = await context.core.oracleForVault(ZeroAddress);
    if (oracle === ZeroAddress) throw new Error("Core wildcard oracle is not configured");
    await upgradeUUPS(context, {
      label: "quex oracle",
      contractName: "UFarmQuexOracle",
      currentAddress: await implementationOf(context, oracle),
      apply: async (newImplementation) => {
        const oracleProxy = await context.ethers.getContractAt("UFarmQuexOracle", oracle);
        await waitAndLog(await oracleProxy.upgradeToAndCall(newImplementation, "0x"));
      },
    });
    return;
  }

  if (target === "batch-oracle") {
    if (batchOracleAddress === undefined) {
      throw new Error("--batch-oracle is required when upgrading the batch oracle");
    }
    const proxy = await context.ethers.getContractAt("UFarmQuexBatchOracle", batchOracleAddress);
    await validateBatchOracleProxy(proxy, context.coreAddress, batchOracleAddress);
    await upgradeUUPS(context, {
      label: "quex batch oracle",
      contractName: "UFarmQuexBatchOracle",
      currentAddress: await implementationOf(context, batchOracleAddress),
      apply: async (newImplementation) => {
        await waitAndLog(await proxy.upgradeToAndCall(newImplementation, "0x"));
      },
    });
    return;
  }

  if (target === "curator") {
    await upgradeBeacon(context, "curator", "UFarmCurator", await context.core.curatorBeacon());
    return;
  }

  if (target === "vault") {
    await upgradeBeacon(context, "vault", "UFarmVault", await context.core.vaultBeacon());
    return;
  }

  if (target === "guard") {
    const guard = guardAddress ?? (await currentArbitraryGuard(context));
    await upgradeUUPS(context, {
      label: "arbitrary guard",
      contractName: "ArbitraryAdapterGuard",
      currentAddress: await implementationOf(context, guard),
      constructorArgs: [context.coreAddress],
      apply: async (newImplementation) => {
        const guardProxy = await context.ethers.getContractAt("ArbitraryAdapterGuard", guard);
        await waitAndLog(await guardProxy.upgradeToAndCall(newImplementation, "0x"));
      },
    });
    return;
  }

  await upgradeAdapters(context, guardAddress);
}

async function upgradeUUPS(context: UpgradeContext, spec: UpgradeSpec): Promise<void> {
  await upgradeImplementation(context, spec);
}

async function upgradeBeacon(
  context: UpgradeContext,
  label: string,
  contractName: string,
  beaconAddress: string,
): Promise<void> {
  const beacon = await context.ethers.getContractAt("UpgradeableBeacon", beaconAddress);
  await upgradeImplementation(context, {
    label,
    contractName,
    currentAddress: await beacon.implementation(),
    apply: async (newImplementation) => {
      await waitAndLog(await beacon.upgradeTo(newImplementation));
    },
  });
}

async function upgradeAdapters(context: UpgradeContext, guardAddress?: string): Promise<void> {
  const currentArbitraryAdapter = await context.core.adapterForVault(ARBITRARY_ADAPTER_ID, ZeroAddress);
  const guard = guardAddress ?? (await currentArbitraryGuard(context));
  await upgradeAdapter(context, {
    label: "arbitrary adapter",
    contractName: "ArbitraryAdapter",
    currentAddress: currentArbitraryAdapter,
    constructorArgs: [guard],
    apply: async (newAdapter) => {
      await waitAndLog(await context.core.setVaultAdapter(ARBITRARY_ADAPTER_ID, ZeroAddress, newAdapter));
    },
  });

  await upgradeAdapter(context, {
    label: "cross-chain adapter",
    contractName: "CrossChainAdapter",
    currentAddress: await context.core.adapterForVault(CROSS_CHAIN_ADAPTER_ID, ZeroAddress),
    apply: async (newAdapter) => {
      await waitAndLog(await context.core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, ZeroAddress, newAdapter));
    },
  });
}

async function upgradeImplementation(context: UpgradeContext, spec: UpgradeSpec): Promise<void> {
  const status = await implementationStatus(context, spec);
  if (!status.changed) {
    console.log(`${spec.label}: unchanged (${spec.currentAddress})`);
    return;
  }

  console.log(`${spec.label}: changed (${spec.currentAddress})`);
  if (context.dryRun) return;

  const next = await deployContract(context, spec.contractName, spec.constructorArgs ?? []);
  await spec.apply(next);
  console.log(`${spec.label}: upgraded to ${next}`);
}

async function upgradeAdapter(context: UpgradeContext, spec: UpgradeSpec): Promise<void> {
  if (spec.currentAddress === ZeroAddress) {
    console.log(`${spec.label}: missing`);
  }
  await upgradeImplementation(context, spec);
}

async function implementationStatus(
  context: UpgradeContext,
  spec: Pick<UpgradeSpec, "contractName" | "currentAddress">,
): Promise<{ changed: boolean }> {
  if (spec.currentAddress === ZeroAddress) return { changed: true };

  const currentCode = await context.ethers.provider.getCode(spec.currentAddress);
  if (currentCode === "0x") return { changed: true };

  const artifact = await artifacts.readArtifact(spec.contractName);
  const immutableReferences = artifact.immutableReferences as ImmutableReferences;
  const expectedHash = normalizedBytecodeHash(artifact.deployedBytecode, immutableReferences);
  const currentHash = normalizedBytecodeHash(currentCode, immutableReferences);
  return { changed: expectedHash !== currentHash };
}

async function deployContract(
  context: UpgradeContext,
  contractName: string,
  constructorArgs: unknown[],
): Promise<string> {
  const contract = await context.ethers.deployContract(contractName, constructorArgs);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`${contractName}: ${address}`);
  return address;
}

async function implementationOf(context: UpgradeContext, proxyAddress: string): Promise<string> {
  const storageValue = await context.ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT);
  const address = getAddress(`0x${storageValue.slice(-40)}`);
  if (address === ZeroAddress) {
    throw new Error(`No ERC1967 implementation at ${proxyAddress}`);
  }
  return address;
}

async function currentArbitraryGuard(context: UpgradeContext): Promise<string> {
  const arbitraryAdapter = await context.core.adapterForVault(ARBITRARY_ADAPTER_ID, ZeroAddress);
  if (arbitraryAdapter === ZeroAddress) {
    throw new Error("Arbitrary adapter is not configured; pass --guard <address> or exclude guard/adapters");
  }

  const adapter = await context.ethers.getContractAt("ArbitraryAdapter", arbitraryAdapter);
  return adapter.guard();
}
