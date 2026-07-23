import { connectReadOnly, optionalAddressArgumentValue, requiredAddressArgument } from "./helpers/exec-helpers.js";

const vaultAddress = requiredAddressArgument("--vault");
const account = optionalAddressArgumentValue("--account");

const { ethers } = await connectReadOnly();
const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);

console.log(`vault: ${vaultAddress}`);
console.log(`name: ${await vault.name()}`);
console.log(`symbol: ${await vault.symbol()}`);
console.log(`asset: ${await vault.asset()}`);
console.log(`core: ${await vault.core()}`);
console.log(`curator: ${await vault.curator()}`);
console.log(`totalSupply: ${await vault.totalSupply()}`);
console.log(`settlementAllowedAt: ${await vault.settlementAllowedAt()}`);

if (account !== undefined) {
  console.log(`balanceOf(${account}): ${await vault.balanceOf(account)}`);
}
