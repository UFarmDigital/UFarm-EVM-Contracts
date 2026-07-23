import type { DeploymentParameters } from "@nomicfoundation/ignition-core";
import { network } from "hardhat";
import { pathToFileURL } from "node:url";
import FoundationAdaptersModule from "../ignition/modules/FoundationAdapters.js";
import FoundationCoreConfigModule from "../ignition/modules/FoundationCoreConfig.js";
import FoundationModule from "../ignition/modules/Foundation.js";
import PrivateSetupModule from "../ignition/modules/PrivateSetup.js";
import {
  DEFAULT_FOUNDATION_LOGICAL_SALT,
  argumentValue,
  buildCreateXSalt,
  hasArgument,
  readIgnitionDeployedAddress,
  requireUFarmChainId,
  resolveIgnitionParameters,
  withFoundationParameters,
} from "./helpers/deploy-helpers.js";
import { waitAndLog } from "./helpers/exec-helpers.js";

const PRIVATE_SETUP_VALUE_TOKEN_PRICE = 100_000_000n;

type CoreConfigAddresses = {
  core: string;
  oracle: string;
  valueToken: string;
  valueTokenPriceFeed: string;
};

type PendingTransaction = {
  hash: string;
  wait: () => Promise<{ status?: number | null }>;
};

type ValueTokenPriceFeed = {
  setRoundData: (answer: bigint, updatedAt: bigint) => Promise<PendingTransaction>;
};

type RefreshValueTokenPriceFeedOptions = {
  dryRun: boolean;
  feed: ValueTokenPriceFeed;
  latestBlockTimestamp: bigint;
  waitForTransaction?: (tx: PendingTransaction) => Promise<void>;
};

export function buildFoundationCoreConfigParameters(
  parameters: DeploymentParameters,
  addresses: CoreConfigAddresses,
): DeploymentParameters {
  return {
    ...parameters,
    FoundationCoreConfig: {
      ...(parameters.FoundationCoreConfig ?? {}),
      ...addresses,
    },
  };
}

export async function refreshValueTokenPriceFeedAndBuildCoreConfigParameters(
  parameters: DeploymentParameters,
  addresses: CoreConfigAddresses,
  options: RefreshValueTokenPriceFeedOptions,
): Promise<DeploymentParameters> {
  if (!options.dryRun) {
    await (options.waitForTransaction ?? waitAndLog)(
      await options.feed.setRoundData(PRIVATE_SETUP_VALUE_TOKEN_PRICE, options.latestBlockTimestamp),
    );
  }

  return buildFoundationCoreConfigParameters(parameters, addresses);
}

async function main(): Promise<void> {
  const dryRun = hasArgument("--dry-run");
  const parametersPath = argumentValue("--parameters");
  const logicalSalt = argumentValue("--logical-salt") ?? DEFAULT_FOUNDATION_LOGICAL_SALT;
  const parameterResolution = parametersPath === undefined ? undefined : resolveIgnitionParameters(parametersPath);
  const privateSetupDeploymentId = argumentValue("--private-setup-deployment-id") ?? "private-setup";
  const foundationDeploymentId = argumentValue("--foundation-deployment-id") ?? "foundation-test";
  requireUFarmChainId();

  console.log("Deploying private-chain test setup");
  console.log(`PrivateSetup deployment id: ${privateSetupDeploymentId}`);
  console.log(`Foundation deployment id: ${foundationDeploymentId}`);
  console.log(`Foundation parameters: ${parameterResolution?.source ?? "none"}`);

  if (dryRun) {
    console.log("dry run: skipping ignition.deploy");
    return;
  }

  const connection = (await network.create("ufarm")) as any;
  const { ethers, ignition } = connection;

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const salt = buildCreateXSalt(deployerAddress, logicalSalt);

  console.log(`deployer: ${deployerAddress}`);
  console.log(`Foundation CreateX salt: ${salt}`);

  let createXAddress = readIgnitionDeployedAddress(privateSetupDeploymentId, "PrivateSetup#CreateX");
  let quexCoreAddress = readIgnitionDeployedAddress(privateSetupDeploymentId, "PrivateSetup#QuexCore");
  let quexRequestOraclePoolAddress = readIgnitionDeployedAddress(
    privateSetupDeploymentId,
    "PrivateSetup#QuexRequestOraclePool",
  );
  let ccipRouterAddress = readIgnitionDeployedAddress(privateSetupDeploymentId, "PrivateSetup#CCIPRouter");
  let valueTokenAddress = readIgnitionDeployedAddress(privateSetupDeploymentId, "PrivateSetup#ValueToken");
  let valueTokenPriceFeedAddress = readIgnitionDeployedAddress(
    privateSetupDeploymentId,
    "PrivateSetup#ValueTokenPriceFeed",
  );
  if (
    createXAddress !== undefined &&
    quexCoreAddress !== undefined &&
    quexRequestOraclePoolAddress !== undefined &&
    ccipRouterAddress !== undefined &&
    valueTokenAddress !== undefined &&
    valueTokenPriceFeedAddress !== undefined &&
    (await ethers.provider.getCode(createXAddress)) !== "0x" &&
    (await ethers.provider.getCode(quexCoreAddress)) !== "0x" &&
    (await ethers.provider.getCode(quexRequestOraclePoolAddress)) !== "0x" &&
    (await ethers.provider.getCode(ccipRouterAddress)) !== "0x" &&
    (await ethers.provider.getCode(valueTokenAddress)) !== "0x" &&
    (await ethers.provider.getCode(valueTokenPriceFeedAddress)) !== "0x"
  ) {
    console.log(`skipping PrivateSetup deployment: ${createXAddress} already exists on chain`);
  } else {
    const privateSetupResult = await ignition.deploy(PrivateSetupModule, {
      defaultSender: deployerAddress,
      deploymentId: privateSetupDeploymentId,
      displayUi: true,
    });
    createXAddress = await privateSetupResult.createX.getAddress();
    quexCoreAddress = await privateSetupResult.quexCore.getAddress();
    quexRequestOraclePoolAddress = await privateSetupResult.quexRequestOraclePool.getAddress();
    ccipRouterAddress = await privateSetupResult.ccipRouter.getAddress();
    valueTokenAddress = await privateSetupResult.valueToken.getAddress();
    valueTokenPriceFeedAddress = await privateSetupResult.valueTokenPriceFeed.getAddress();
  }
  console.log(`createX: ${createXAddress}`);
  if (quexCoreAddress !== undefined) console.log(`quexCore: ${quexCoreAddress}`);
  if (quexRequestOraclePoolAddress !== undefined) console.log(`quexRequestOraclePool: ${quexRequestOraclePoolAddress}`);
  if (ccipRouterAddress !== undefined) console.log(`ccipRouter: ${ccipRouterAddress}`);
  if (valueTokenAddress !== undefined) console.log(`valueToken: ${valueTokenAddress}`);
  if (valueTokenPriceFeedAddress !== undefined) console.log(`valueTokenPriceFeed: ${valueTokenPriceFeedAddress}`);
  if (createXAddress === undefined) {
    throw new Error("PrivateSetup did not produce a CreateX address");
  }
  if (valueTokenAddress === undefined) {
    throw new Error("PrivateSetup did not produce a value token address");
  }
  if (valueTokenPriceFeedAddress === undefined) {
    throw new Error("PrivateSetup did not produce a value token price feed address");
  }
  if (quexCoreAddress === undefined) {
    throw new Error("PrivateSetup did not produce a Quex core address");
  }
  if (quexRequestOraclePoolAddress === undefined) {
    throw new Error("PrivateSetup did not produce a Quex request oracle pool address");
  }
  if (ccipRouterAddress === undefined) {
    throw new Error("PrivateSetup did not produce a CCIP router address");
  }

  const parameters = withFoundationParameters(parameterResolution?.parameters, {
    createX: createXAddress,
    quexCore: quexCoreAddress,
    salt,
  });

  const foundationResult = await ignition.deploy(FoundationModule, {
    defaultSender: deployerAddress,
    deploymentId: foundationDeploymentId,
    parameters,
    displayUi: true,
  });

  for (const [name, value] of Object.entries(foundationResult)) {
    const maybeContract = value as { getAddress?: () => Promise<string> };
    if (typeof maybeContract.getAddress === "function") {
      console.log(`${name}: ${await maybeContract.getAddress()}`);
    }
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  if (latestBlock === null) {
    throw new Error("Unable to read the latest block");
  }
  const valueTokenPriceFeed = await ethers.getContractAt("MockChainlinkAggregator", valueTokenPriceFeedAddress);

  const coreConfigParameters = await refreshValueTokenPriceFeedAndBuildCoreConfigParameters(
    parameters,
    {
      core: await foundationResult.core.getAddress(),
      oracle: await foundationResult.quexOracle.getAddress(),
      valueToken: valueTokenAddress,
      valueTokenPriceFeed: valueTokenPriceFeedAddress,
    },
    {
      dryRun,
      feed: valueTokenPriceFeed,
      latestBlockTimestamp: BigInt(latestBlock.timestamp),
    },
  );

  await ignition.deploy(FoundationCoreConfigModule, {
    defaultSender: deployerAddress,
    deploymentId: foundationDeploymentId,
    parameters: coreConfigParameters,
    displayUi: true,
  });

  const adapterParameters = {
    ...coreConfigParameters,
    FoundationAdapters: {
      ...(coreConfigParameters.FoundationAdapters ?? {}),
      core: await foundationResult.core.getAddress(),
      crossChainRouter: ccipRouterAddress,
      crossChainFeeToken: valueTokenAddress,
      crossChainToken: valueTokenAddress,
    },
  };

  await ignition.deploy(FoundationAdaptersModule, {
    defaultSender: deployerAddress,
    deploymentId: foundationDeploymentId,
    parameters: adapterParameters,
    displayUi: true,
  });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
