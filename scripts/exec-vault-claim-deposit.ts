import {
  connectWithRole,
  optionalAddressArgument,
  requiredAddressArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");

const { ethers } = await connectWithRole("PK_INVESTOR");
const [investor] = await ethers.getSigners();
const owner = optionalAddressArgument("--owner", await investor.getAddress());
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);

const shares = await vault.deposit.staticCall(0, owner, owner);
const tx = await vault.deposit(0, owner, owner);

console.log(`shares: ${shares}`);
await waitAndLog(tx);
