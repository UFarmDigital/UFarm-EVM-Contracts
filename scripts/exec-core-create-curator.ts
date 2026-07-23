import { connectWithRole, parseSaltArgument, requiredAddressArgument, waitAndLog } from "./helpers/exec-helpers.js";

const coreAddress = requiredAddressArgument("--core");
const curatorOwner = requiredAddressArgument("--owner");
const salt = parseSaltArgument();

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const core = await ethers.getContractAt("IUFarmCore", coreAddress);

const curator = await core.createCurator.staticCall(curatorOwner, salt);
const tx = await core.createCurator(curatorOwner, salt);

console.log(`curator: ${curator}`);
await waitAndLog(tx);
