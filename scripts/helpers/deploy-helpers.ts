import type { DeploymentParameters } from "@nomicfoundation/ignition-core";
import "dotenv/config";
import { getAddress, id, isHexString, zeroPadValue } from "ethers";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FOUNDATION_LOGICAL_SALT = id("UFARM_FOUNDATION");

type ResolveIgnitionParametersResult = {
  parameters: DeploymentParameters;
  source?: string;
};

export function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function hasArgument(name: string): boolean {
  return process.argv.includes(name);
}

export function requireUFarmChainId(): number {
  const chainId = process.env.UFARM_CHAIN_ID === undefined ? undefined : Number(process.env.UFARM_CHAIN_ID);
  if (chainId === undefined || !Number.isInteger(chainId)) {
    throw new Error("UFARM_CHAIN_ID is required and must be an integer");
  }
  return chainId;
}

export function readIgnitionDeployedAddress(deploymentId: string, futureId: string): string | undefined {
  const addressesPath = path.join("ignition", "deployments", deploymentId, "deployed_addresses.json");
  if (!fs.existsSync(addressesPath)) return undefined;

  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8")) as Record<string, string>;
  return addresses[futureId];
}

export function buildCreateXSalt(deployer: string, logicalSalt: string = DEFAULT_FOUNDATION_LOGICAL_SALT): string {
  if (!isHexString(logicalSalt, 32)) {
    throw new Error("logicalSalt must be a 32-byte hex string");
  }

  return `${zeroPadValue(getAddress(deployer), 20)}00${logicalSalt.slice(44)}`;
}

export function resolveIgnitionParameters(parametersPath: string): ResolveIgnitionParametersResult {
  if (!fs.existsSync(parametersPath)) {
    throw new Error(`Ignition parameters file not found: ${parametersPath}`);
  }

  return {
    parameters: JSON.parse(fs.readFileSync(parametersPath, "utf8")) as DeploymentParameters,
    source: path.relative(process.cwd(), parametersPath),
  };
}

export function withFoundationParameters(
  parameters: DeploymentParameters | undefined,
  foundationParameters: DeploymentParameters["Foundation"],
): DeploymentParameters {
  return {
    ...(parameters ?? {}),
    Foundation: {
      ...(parameters?.Foundation ?? {}),
      ...foundationParameters,
    },
  };
}
