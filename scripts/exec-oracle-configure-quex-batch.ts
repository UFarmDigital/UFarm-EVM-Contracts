import {
  connectWithRole,
  requiredAddressArgument,
  requiredUintArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const oracleAddress = requiredAddressArgument("--oracle");
const vaultAddress = requiredAddressArgument("--vault");
const actionId = requiredUintArgument("--action-id");

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const oracle = await ethers.getContractAt("UFarmQuexBatchOracle", oracleAddress);
console.log(`oracle: ${oracleAddress}`);
console.log(`vault: ${vaultAddress}`);
console.log(`actionId: ${actionId}`);
await waitAndLog(await oracle.setQuexActionData(vaultAddress, actionId));
