import { expect } from "chai";
import { AbiCoder, getAddress } from "ethers";
import { buildContractCall, formatDecodedResult } from "../../scripts/helpers/contract-call-helpers.js";

describe("Generic contract call exec helper", function () {
  it("encodes a no-argument call and formats named multi-value returns", function () {
    const call = buildContractCall("fees()", undefined, "(uint256 managementFee, uint256 performanceFeeSchedule)");
    const returnData = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [304000n, 332000n]);

    expect(call.data).to.equal("0x9af1d35a");
    expect(formatDecodedResult(call, returnData)).to.deep.equal([
      "managementFee: 304000",
      "performanceFeeSchedule: 332000",
    ]);
  });

  it("encodes a named address argument and formats a named address return", function () {
    const vaultAddress = "0xB43dea9631F1357aB4a59040b918B67229e25b69";
    const oracleAddress = "0xD8A234e00456b6f85751c703f1521885f0758Bf1";
    const call = buildContractCall("oracleForVault(address vaultAddress)", vaultAddress, "(address oracle)");
    const returnData = AbiCoder.defaultAbiCoder().encode(["address"], [oracleAddress]);

    expect(call.args).to.deep.equal([getAddress(vaultAddress)]);
    expect(call.data).to.equal(`0x${"209a238e"}${vaultAddress.toLowerCase().slice(2).padStart(64, "0")}`);
    expect(formatDecodedResult(call, returnData)).to.deep.equal([`oracle: ${getAddress(oracleAddress)}`]);
  });
});
