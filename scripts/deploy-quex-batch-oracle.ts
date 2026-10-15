import { network } from "hardhat";
import QuexBatchOracleModule from "../ignition/modules/QuexBatchOracle.js";
import {
  argumentValue,
  hasArgument,
  requireUFarmChainId,
  resolveIgnitionParameters,
} from "./helpers/deploy-helpers.js";

const noParameters = hasArgument("--no-parameters");
const parametersPath = argumentValue("--parameters");
const dryRun = hasArgument("--dry-run");
const deploymentId = argumentValue("--deployment-id");
if (noParameters === (parametersPath !== undefined)) {
  throw new Error("Pass either --no-parameters to use module defaults or --parameters <path-to-json>.");
}
requireUFarmChainId();

const parameterResolution = parametersPath === undefined ? undefined : resolveIgnitionParameters(parametersPath);
const parameters = parameterResolution?.parameters;

console.log("Deploying QuexBatchOracle");
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
  console.log(`deployer: ${deployerAddress}`);

  const result = await ignition.deploy(QuexBatchOracleModule, {
    defaultSender: deployerAddress,
    ...(parameters === undefined ? {} : { parameters }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
    displayUi: true,
  });
  console.log(`quexBatchOracle: ${await result.quexBatchOracle.getAddress()}`);
}
