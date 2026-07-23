import { connectWithRole, requiredArgument, requiredAddressArgument, waitAndLog } from "./helpers/exec-helpers.js";
import { parseDappId, parseEIP712DirectiveEntries } from "./helpers/guard-whitelist-helpers.js";

const guardAddress = requiredAddressArgument("--guard");
const dapp = parseDappId(requiredArgument("--dapp"));
const domain = requiredArgument("--domain");
const directives = parseEIP712DirectiveEntries(requiredArgument("--directives"));

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const guard = await ethers.getContractAt("ArbitraryAdapterGuard", guardAddress);

if (!ethers.isHexString(domain, 32)) {
  throw new Error("--domain must be bytes32");
}

console.log(`guard: ${guardAddress}`);
console.log(`dapp: ${dapp}`);
console.log(`domain: ${domain}`);
console.log(`directives count: ${directives.length}`);
await waitAndLog(await guard.whitelistEIP712(dapp, domain, directives));
