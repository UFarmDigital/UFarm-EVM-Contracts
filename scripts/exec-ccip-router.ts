import {
  argumentValue,
  connectWithRole,
  requiredAddressArgument,
  requiredUintArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const routerAddress = requiredAddressArgument("--router");
const action = argumentValue("--action") ?? "set-fee";

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const router = await ethers.getContractAt("MockCCIPRouter", routerAddress);

if (action === "set-fee") {
  const fee = requiredUintArgument("--fee");
  const tx = await router.setFee(fee);
  console.log(`fee: ${fee}`);
  await waitAndLog(tx);
} else if (action === "set-fail-send") {
  const enabled = requiredBooleanArgument("--enabled");
  const tx = await router.setFailSend(enabled);
  console.log(`failSend: ${enabled}`);
  await waitAndLog(tx);
} else if (action === "set-fail-get-fee") {
  const enabled = requiredBooleanArgument("--enabled");
  const tx = await router.setFailGetFee(enabled);
  console.log(`failGetFee: ${enabled}`);
  await waitAndLog(tx);
} else {
  throw new Error("Unsupported --action. Use set-fee, set-fail-send, or set-fail-get-fee");
}

function requiredBooleanArgument(name: string): boolean {
  const value = argumentValue(name);
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true/false or 1/0`);
}
