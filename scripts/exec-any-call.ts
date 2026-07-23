import { argumentValue, connectReadOnly, requiredAddressArgument, requiredArgument } from "./helpers/exec-helpers.js";
import { buildContractCall, formatDecodedResult } from "./helpers/contract-call-helpers.js";

const contractAddress = requiredAddressArgument("--contract");
const execute = requiredArgument("--execute");
const args = argumentValue("--args");
const returnTypes = requiredArgument("--return");

const { ethers } = await connectReadOnly();
const call = buildContractCall(execute, args, returnTypes);
const returnData = await ethers.provider.call({ to: contractAddress, data: call.data });

for (const line of formatDecodedResult(call, returnData)) {
  console.log(line);
}
