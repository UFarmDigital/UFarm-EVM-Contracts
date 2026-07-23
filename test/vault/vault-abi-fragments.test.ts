import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("UFarmVault ABI fragments", function () {
  it("exposes module events and errors without duplicate event or error signatures", async function () {
    const factory = await ethers.getContractFactory("UFarmVault");
    const fragments = factory.interface.fragments.filter(
      (fragment) => fragment.type === "event" || fragment.type === "error",
    );
    const signatures = fragments.map((fragment) => `${fragment.type}:${fragment.format()}`);
    const duplicates = signatures.filter((signature, index) => signatures.indexOf(signature) !== index);

    expect(duplicates).to.deep.equal([]);
    expect(signatures).to.include.members([
      "event:VaultFeesUpdated(uint256,uint256)",
      "event:DepositRequest(address,address,uint256,address,uint256)",
      "event:OracleNAVReceived(address,uint256,uint256,uint64)",
      "event:AdapterExecuted(bytes32)",
      "error:FeeConfigLocked()",
      "error:RequestStateError(uint8)",
      "error:OracleFlowError(uint8)",
      "error:CrossChainFlowError(uint8)",
    ]);
  });
});
