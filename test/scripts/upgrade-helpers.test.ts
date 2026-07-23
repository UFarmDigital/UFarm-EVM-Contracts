import { expect } from "chai";
import { keccak256 } from "ethers";
import {
  normalizeDeployedBytecode,
  normalizedBytecodeHash,
  parseUpgradeTargets,
} from "../../scripts/helpers/upgrade-helpers";

describe("upgrade helpers", function () {
  it("expands all upgrade targets", function () {
    expect(parseUpgradeTargets("all")).to.deep.equal([
      "core",
      "escrow",
      "oracle",
      "curator",
      "vault",
      "guard",
      "adapters",
    ]);
  });

  it("parses explicit upgrade targets in order without duplicates", function () {
    expect(parseUpgradeTargets("vault,core,oracle,vault,adapters")).to.deep.equal([
      "vault",
      "core",
      "oracle",
      "adapters",
    ]);
  });

  it("rejects unknown upgrade targets", function () {
    expect(() => parseUpgradeTargets("core,unknown")).to.throw("Unknown upgrade target: unknown");
  });

  it("normalizes immutable bytecode ranges before hashing", function () {
    const artifactBytecode = `0x6000${"00".repeat(20)}5b`;
    const deployedBytecode = `0x6000${"11".repeat(20)}5b`;
    const immutableReferences = {
      "3": [{ start: 2, length: 20 }],
    };

    expect(normalizeDeployedBytecode(deployedBytecode, immutableReferences)).to.equal(artifactBytecode);
    expect(normalizedBytecodeHash(deployedBytecode, immutableReferences)).to.equal(keccak256(artifactBytecode));
  });
});
