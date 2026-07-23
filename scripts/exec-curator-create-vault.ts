import {
  connectWithRole,
  parseSaltArgument,
  requiredAddressArgument,
  requiredArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const curatorAddress = requiredAddressArgument("--curator");
const vaultOwner = requiredAddressArgument("--owner");
const salt = parseSaltArgument();
const name = requiredArgument("--name");
const symbol = requiredArgument("--symbol");
const asset = requiredAddressArgument("--asset");

const { ethers } = await connectWithRole("PK_VAULT_OWNER");
const curator = await ethers.getContractAt("IUFarmCurator", curatorAddress);

const vault = await curator.createVault.staticCall(salt, vaultOwner, name, symbol, asset);
const tx = await curator.createVault(salt, vaultOwner, name, symbol, asset);

console.log(`vault: ${vault}`);
await waitAndLog(tx);
