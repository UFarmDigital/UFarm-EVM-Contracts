import {
  connectWithRole,
  optionalAddressArgument,
  optionalAddressArgumentValue,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");

const { ethers } = await connectWithRole("PK_INVESTOR");
const [investor] = await ethers.getSigners();
const investorAddress = await investor.getAddress();
const owner = optionalAddressArgument("--owner", investorAddress);
const receiver = optionalAddressArgumentValue("--receiver");
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);

const redeemReceiver = receiver ?? owner;
const assets = await vault.redeem.staticCall(0, redeemReceiver, owner);
const tx = await vault.redeem(0, redeemReceiver, owner);

console.log(`assets: ${assets}`);
await waitAndLog(tx);
