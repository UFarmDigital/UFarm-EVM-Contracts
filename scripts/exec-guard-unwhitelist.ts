import { connectWithRole, requiredAddressArgument, requiredArgument, waitAndLog } from "./helpers/exec-helpers.js";
import { parseDappId, parseIndexList } from "./helpers/guard-whitelist-helpers.js";

const guardAddress = requiredAddressArgument("--guard");
const dapp = parseDappId(requiredArgument("--dapp"));
const target = requiredAddressArgument("--target");
const indexes = parseIndexList(requiredArgument("--idx"));

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const guard = await ethers.getContractAt("ArbitraryAdapterGuard", guardAddress);

console.log(`guard: ${guardAddress}`);
console.log(`dapp: ${dapp}`);
console.log(`target: ${target}`);
console.log(`idx: ${indexes.join(",")}`);
await waitAndLog(await guard.unwhitelistProtocol(dapp, target, indexes));
