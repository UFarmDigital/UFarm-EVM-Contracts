import { connectReadOnly, requiredAddressArgument } from "./helpers/exec-helpers.js";

const contractAddress = requiredAddressArgument("--contract");
const account = requiredAddressArgument("--account");

const { ethers } = await connectReadOnly();
const permissions = await ethers.getContractAt("IUFarmPermissions", contractAddress);
const permissionMask = await permissions.permissionMask(account);

console.log(`contract: ${contractAddress}`);
console.log(`account: ${account}`);
console.log(`permissionMask: ${permissionMask}`);
