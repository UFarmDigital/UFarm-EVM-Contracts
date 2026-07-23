import { connectWithRole, requiredAddressArgument, waitAndLog } from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");

const { ethers } = await connectWithRole("PK_VAULT_OWNER");
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);

const oracleRequestId = await vault.settleRequests.staticCall();
const tx = await vault.settleRequests();

console.log(`oracleRequestId: ${oracleRequestId}`);
await waitAndLog(tx);
