import { connectWithRole, requiredAddressArgument, requiredArgument, waitAndLog } from "./helpers/exec-helpers.js";
import { parseDappId, parseHexBytesList, parseTargetList } from "./helpers/guard-whitelist-helpers.js";

const guardAddress = requiredAddressArgument("--guard");
const dapp = parseDappId(requiredArgument("--dapp"));
const targets = parseTargetList(requiredArgument("--targets"));
const directives = parseHexBytesList(requiredArgument("--directives"));

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const guard = await ethers.getContractAt("ArbitraryAdapterGuard", guardAddress);

console.log(`guard: ${guardAddress}`);
console.log(`dapp: ${dapp}`);
console.log(`targets: ${targets.join(",")}`);
console.log(`directives: ${directives.join(",")}`);
await waitAndLog(await guard.whitelistProtocol(dapp, targets, directives));
