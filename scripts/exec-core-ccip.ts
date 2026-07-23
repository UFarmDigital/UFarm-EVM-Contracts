import {
  argumentValue,
  connectWithRole,
  optionalAddressArgumentValue,
  optionalUintArgument,
  requiredAddressArgument,
  requiredUintArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const coreAddress = requiredAddressArgument("--core");
const action = argumentValue("--action") ?? "set-selector";

const { ethers } = await connectWithRole("PK_UFARM_OWNER");
const core = await ethers.getContractAt("UFarmCore", coreAddress);

if (action === "set-selector") {
  const chainId = requiredUintArgument("--chain-id");
  const selector = requiredUintArgument("--selector");
  const tx = await core.setCCIPSelector(chainId, selector);
  console.log(`chainId: ${chainId}`);
  console.log(`selector: ${selector}`);
  await waitAndLog(tx);
} else if (action === "set-router") {
  const router = requiredAddressArgument("--router");
  const tx = await core.setCrossChainRouter(router);
  console.log(`router: ${router}`);
  await waitAndLog(tx);
} else if (action === "set-fee-token") {
  const feeToken = requiredAddressArgument("--fee-token");
  const tx = await core.setCrossChainFeeToken(feeToken);
  console.log(`feeToken: ${feeToken}`);
  await waitAndLog(tx);
} else if (action === "set-token") {
  const token = requiredAddressArgument("--token");
  const tx = await core.setCrossChainToken(token);
  console.log(`token: ${token}`);
  await waitAndLog(tx);
} else if (action === "set-gas-limit") {
  const gasLimit = requiredUintArgument("--gas-limit");
  const tx = await core.setCrossChainGasLimit(gasLimit);
  console.log(`gasLimit: ${gasLimit}`);
  await waitAndLog(tx);
} else if (action === "configure") {
  const router = optionalAddressArgumentValue("--router");
  const feeToken = optionalAddressArgumentValue("--fee-token");
  const token = optionalAddressArgumentValue("--token");
  const gasLimit = optionalUintArgument("--gas-limit", 0n);
  const chainId = optionalUintArgument("--chain-id", 0n);
  const selector = optionalUintArgument("--selector", 0n);

  if (router !== undefined) await waitAndLog(await core.setCrossChainRouter(router));
  if (feeToken !== undefined) await waitAndLog(await core.setCrossChainFeeToken(feeToken));
  if (token !== undefined) await waitAndLog(await core.setCrossChainToken(token));
  if (gasLimit !== 0n) await waitAndLog(await core.setCrossChainGasLimit(gasLimit));
  if (chainId !== 0n || selector !== 0n) {
    if (chainId === 0n || selector === 0n) throw new Error("--chain-id and --selector must be passed together");
    await waitAndLog(await core.setCCIPSelector(chainId, selector));
  }
} else {
  throw new Error(
    "Unsupported --action. Use set-selector, set-router, set-fee-token, set-token, set-gas-limit, or configure",
  );
}
