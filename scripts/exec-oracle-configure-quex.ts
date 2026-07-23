import fs from "node:fs/promises";
import {
  connectWithRole,
  optionalUintArgument,
  requiredArgument,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";
import { buildQuexActionData, extractQuexBytes32EventValue } from "./helpers/quex-request-helpers.js";

const oracleAddress = requiredAddressArgument("--oracle");
const requestPoolAddress = requiredAddressArgument("--request-pool");
const requestPath = requiredArgument("--request");
const gasLimit = optionalUintArgument("--gas-limit", 1_000_000n);
const tdPublicKey = requiredArgument("--td-pubkey");

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const oracle = await ethers.getContractAt("UFarmQuexOracle", oracleAddress);
const requestPoolAbi = [
  "event PrivatePatchAdded(bytes32 patchId)",
  "event JqFilterAdded(bytes32 filterId)",
  "event ResultSchemaAdded(bytes32 schemaId)",
  "function addPrivatePatch((bytes pathSuffix,(string key,bytes ciphertext)[] headers,(string key,bytes ciphertext)[] parameters,bytes body,address tdAddress) privatePatch) returns (bytes32 patchId)",
  "function addJqFilter(string jqFilter) returns (bytes32 filterId)",
  "function addResponseSchema(string responseSchema) returns (bytes32 schemaId)",
];
const requestPoolInterface = new ethers.Interface(requestPoolAbi);
const requestPool = new ethers.Contract(requestPoolAddress, requestPoolInterface, await ethers.provider.getSigner());

console.log(`reading request: ${requestPath}`);
const actionData = buildQuexActionData(JSON.parse(await fs.readFile(requestPath, "utf8")), tdPublicKey);
console.log(`request host: ${actionData.request.host}`);

const patchId = await submitQuexPart("private patch", "PrivatePatchAdded", "patchId", () =>
  requestPool.addPrivatePatch(actionData.patch),
);
console.log(`patchId: ${patchId}`);

const filterId = await submitQuexPart("jq filter", "JqFilterAdded", "filterId", () =>
  requestPool.addJqFilter(actionData.jqFilter),
);
console.log(`filterId: ${filterId}`);

const schemaId = await submitQuexPart("response schema", "ResultSchemaAdded", "schemaId", () =>
  requestPool.addResponseSchema(actionData.responseSchema),
);
console.log(`schemaId: ${schemaId}`);

console.log("configuring UFarm Quex oracle");
const tx = await oracle.setQuexActionData(
  requestPoolAddress,
  actionData.request,
  patchId,
  schemaId,
  filterId,
  gasLimit,
);

console.log(`oracle: ${oracleAddress}`);
console.log(`requestPool: ${requestPoolAddress}`);
await waitAndLog(tx);

async function submitQuexPart(
  label: string,
  eventName: string,
  argumentName: string,
  send: () => Promise<{
    hash: string;
    wait: () => Promise<{ status?: number | null; logs: readonly { topics: readonly string[]; data: string }[] }>;
  }>,
): Promise<string> {
  console.log(`submitting ${label}`);
  const tx = await send();
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`status: ${receipt.status ?? "unknown"}`);
  return extractQuexBytes32EventValue(requestPoolInterface, receipt.logs, eventName, argumentName);
}
