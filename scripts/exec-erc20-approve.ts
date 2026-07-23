import { Contract, parseUnits } from "ethers";
import {
  argumentValue,
  connectWithRole,
  requiredAddressArgument,
  requiredArgument,
  waitAndLog,
  type RolePrivateKey,
} from "./helpers/exec-helpers.js";

const tokenAddress = requiredAddressArgument("--token");
const spender = requiredAddressArgument("--spender");
const amountText = requiredArgument("--amount");
const role = (argumentValue("--role") ?? "PK_INVESTOR") as RolePrivateKey;

const { ethers } = await connectWithRole(role);
const [signer] = await ethers.getSigners();
const token = new Contract(
  tokenAddress,
  ["function decimals() view returns (uint8)", "function approve(address spender, uint256 value) returns (bool)"],
  signer,
);
const decimals = Number(argumentValue("--decimals") ?? (await token.decimals()));
const amount = amountText.includes(".") ? parseUnits(amountText, decimals) : BigInt(amountText);

const tx = await token.approve(spender, amount);

console.log(`token: ${tokenAddress}`);
console.log(`spender: ${spender}`);
console.log(`amount: ${amount}`);
await waitAndLog(tx);
