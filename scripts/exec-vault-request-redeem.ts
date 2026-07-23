import {
  connectWithRole,
  optionalAddressArgument,
  parseTokenAmountArgument,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");
const shares = parseTokenAmountArgument("--shares");

const { ethers } = await connectWithRole("PK_INVESTOR");
const [investor] = await ethers.getSigners();
const investorAddress = await investor.getAddress();
const controller = optionalAddressArgument("--controller", investorAddress);
const owner = optionalAddressArgument("--owner", investorAddress);
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);

const requestId = await vault.requestRedeem.staticCall(shares, controller, owner);
const tx = await vault.requestRedeem(shares, controller, owner);

console.log(`requestId: ${requestId}`);
await waitAndLog(tx);
