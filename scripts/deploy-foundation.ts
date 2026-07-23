import { network } from "hardhat";
import FoundationAdaptersModule from "../ignition/modules/FoundationAdapters.js";
import FoundationCoreConfigModule from "../ignition/modules/FoundationCoreConfig.js";
import FoundationModule from "../ignition/modules/Foundation.js";
import FoundationTimelockModule from "../ignition/modules/FoundationTimelock.js";
import {
  DEFAULT_FOUNDATION_LOGICAL_SALT,
  argumentValue,
  buildCreateXSalt,
  hasArgument,
  requireUFarmChainId,
  resolveIgnitionParameters,
  withFoundationParameters,
} from "./helpers/deploy-helpers.js";

const noParameters = hasArgument("--no-parameters");
const parametersPath = argumentValue("--parameters");
const dryRun = hasArgument("--dry-run");
const deploymentId = argumentValue("--deployment-id");
const logicalSalt = argumentValue("--logical-salt") ?? DEFAULT_FOUNDATION_LOGICAL_SALT;
const deployFoundation = hasArgument("--foundation");
const deployTimelock = hasArgument("--timelock");
const deployAdapters = hasArgument("--adapters");
const deployCoreConfig = hasArgument("--core-config");
if (noParameters === (parametersPath !== undefined)) {
  throw new Error("Pass either --no-parameters to use module defaults or --parameters <path-to-json>.");
}
requireUFarmChainId();

const parameterResolution = parametersPath === undefined ? undefined : resolveIgnitionParameters(parametersPath);
const parameters = parameterResolution?.parameters;
const modules = [
  ...(deployFoundation ? ["Foundation"] : []),
  ...(deployCoreConfig ? ["FoundationCoreConfig"] : []),
  ...(deployAdapters ? ["FoundationAdapters"] : []),
  ...(deployTimelock ? ["FoundationTimelock"] : []),
];
if (modules.length === 0) {
  throw new Error("Pass at least one module flag: --foundation, --core-config, --adapters, or --timelock.");
}

console.log(`Deploying ${modules.join(", ")} with Foundation Create3 salt`);
console.log(`logical salt: ${logicalSalt}`);
if (noParameters) console.log("parameters: disabled by --no-parameters");
else console.log(`parameters: ${parameterResolution?.source ?? "none"}`);
if (deploymentId !== undefined) console.log(`deployment id: ${deploymentId}`);

if (dryRun) {
  console.log("dry run: skipping ignition.deploy");
} else {
  const connection = (await network.create("ufarm")) as any;
  const { ethers, ignition } = connection;

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const salt = buildCreateXSalt(deployerAddress, logicalSalt);

  console.log(`deployer: ${deployerAddress}`);
  console.log(`CreateX salt: ${salt}`);

  const foundationParameters = withFoundationParameters(parameters, { salt });

  const deploy = async (name: string, module: typeof FoundationModule, moduleParameters = parameters) => {
    console.log(`\nDeploying [ ${name} ]`);
    const result = await ignition.deploy(module, {
      defaultSender: deployerAddress,
      ...(moduleParameters === undefined ? {} : { parameters: moduleParameters }),
      ...(deploymentId === undefined ? {} : { deploymentId }),
      displayUi: true,
    });

    for (const [contractName, value] of Object.entries(result)) {
      const maybeContract = value as { getAddress?: () => Promise<string> };
      if (typeof maybeContract.getAddress === "function") {
        console.log(`${contractName}: ${await maybeContract.getAddress()}`);
      }
    }

    return result;
  };

  let core =
    parameters?.FoundationCoreConfig?.core ??
    parameters?.FoundationAdapters?.core ??
    parameters?.FoundationTimelock?.core;
  let oracle = parameters?.FoundationCoreConfig?.oracle;
  let curatorBeacon = parameters?.FoundationTimelock?.curatorBeacon;
  let vaultBeacon = parameters?.FoundationTimelock?.vaultBeacon;

  if (deployFoundation) {
    const foundationResult = await deploy("Foundation", FoundationModule, foundationParameters);
    core = await foundationResult.core.getAddress();
    oracle = await foundationResult.quexOracle.getAddress();
    curatorBeacon = await foundationResult.curatorBeacon.getAddress();
    vaultBeacon = await foundationResult.vaultBeacon.getAddress();
  }

  if ((deployCoreConfig || deployAdapters || deployTimelock) && core === undefined) {
    throw new Error("Core address is required in parameters when --foundation is not passed.");
  }
  if (deployCoreConfig && oracle === undefined) {
    throw new Error("FoundationCoreConfig.oracle is required in parameters when --foundation is not passed.");
  }
  if (deployTimelock && (curatorBeacon === undefined || vaultBeacon === undefined)) {
    throw new Error(
      "FoundationTimelock curatorBeacon and vaultBeacon are required in parameters when --foundation is not passed.",
    );
  }

  const moduleParameters = {
    ...(parameters ?? {}),
    FoundationCoreConfig: {
      ...(parameters?.FoundationCoreConfig ?? {}),
      core,
      oracle,
    },
    FoundationAdapters: {
      ...(parameters?.FoundationAdapters ?? {}),
      core,
    },
    FoundationTimelock: {
      ...(parameters?.FoundationTimelock ?? {}),
      core,
      curatorBeacon,
      vaultBeacon,
    },
  };

  if (deployCoreConfig) {
    await deploy("FoundationCoreConfig", FoundationCoreConfigModule, moduleParameters);
  }
  if (deployAdapters) {
    await deploy("FoundationAdapters", FoundationAdaptersModule, moduleParameters);
  }
  if (deployTimelock) {
    await deploy("FoundationTimelock", FoundationTimelockModule, moduleParameters);
  }
}
