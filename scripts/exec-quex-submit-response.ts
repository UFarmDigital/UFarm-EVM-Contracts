import { AbiCoder } from "ethers";
import {
  connectWithRole,
  optionalUintArgument,
  requiredAddressArgument,
  requiredUintArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const quexCoreAddress = requiredAddressArgument("--quex-core");
const oracleAddress = requiredAddressArgument("--oracle");
const requestId = requiredUintArgument("--request-id");
const nav = requiredUintArgument("--nav");

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const latestBlock = await ethers.provider.getBlock("latest");
const timestamp = optionalUintArgument("--timestamp", BigInt(latestBlock!.timestamp + 1));
const quexCore = await ethers.getContractAt("MockQuexCore", quexCoreAddress);

const response = {
  timestamp,
  errorCode: 0n,
  value: AbiCoder.defaultAbiCoder().encode(["uint256"], [nav]),
};
const tx = await quexCore.submitResponse(oracleAddress, requestId, response);

console.log(`requestId: ${requestId}`);
console.log(`nav: ${nav}`);
console.log(`timestamp: ${timestamp}`);
await waitAndLog(tx);
