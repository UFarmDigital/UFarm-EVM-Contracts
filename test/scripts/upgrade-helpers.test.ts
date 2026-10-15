import { expect } from "chai";
import { keccak256 } from "ethers";
import assert from "node:assert/strict";
import {
  normalizeDeployedBytecode,
  normalizedBytecodeHash,
  parseUpgradeTargets,
  validateBatchOracleProxy,
} from "../../scripts/helpers/upgrade-helpers";

const CORE = "0x1111111111111111111111111111111111111111";
const OTHER_CORE = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const PROXY = "0x4444444444444444444444444444444444444444";

function batchOracleProbe(core = CORE, requestOraclePool = POOL, gasLimit = 1_000_000n) {
  return {
    core: async () => core,
    requestOraclePool: async () => requestOraclePool,
    gasLimit: async () => gasLimit,
  };
}

describe("upgrade helpers", function () {
  it("expands all upgrade targets", function () {
    expect(parseUpgradeTargets("all")).to.deep.equal([
      "core",
      "escrow",
      "oracle",
      "batch-oracle",
      "curator",
      "vault",
      "guard",
      "adapters",
    ]);
  });

  it("parses explicit upgrade targets in order without duplicates", function () {
    expect(parseUpgradeTargets("batch-oracle,oracle,batch-oracle")).to.deep.equal(["batch-oracle", "oracle"]);
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

  it("accepts a configured batch oracle for the expected core", async function () {
    await validateBatchOracleProxy(batchOracleProbe(), CORE, PROXY);
  });

  it("rejects a batch oracle belonging to another core", async function () {
    await assert.rejects(
      validateBatchOracleProxy(batchOracleProbe(OTHER_CORE), CORE, PROXY),
      /Batch oracle proxy .* belongs to core .*; expected .*/,
    );
  });

  it("rejects a batch oracle with a zero pool", async function () {
    await assert.rejects(
      validateBatchOracleProxy(batchOracleProbe(CORE, "0x0000000000000000000000000000000000000000"), CORE, PROXY),
      /Batch oracle proxy .* has invalid requestOraclePool\(\)/,
    );
  });

  it("rejects a batch oracle with a zero gas limit", async function () {
    await assert.rejects(
      validateBatchOracleProxy(batchOracleProbe(CORE, POOL, 0n), CORE, PROXY),
      /Batch oracle proxy .* has invalid gasLimit\(\)/,
    );
  });

  it("rejects a legacy-like proxy that lacks batch getters", async function () {
    await assert.rejects(
      validateBatchOracleProxy({ core: async () => CORE }, CORE, PROXY),
      /Cannot validate batch oracle proxy .*: core\(\), requestOraclePool\(\), or gasLimit\(\) call failed/,
    );
  });

  it("rejects a proxy when a batch getter reverts", async function () {
    const probe = batchOracleProbe();
    probe.gasLimit = async () => {
      throw new Error("execution reverted");
    };

    await assert.rejects(
      validateBatchOracleProxy(probe, CORE, PROXY),
      /Cannot validate batch oracle proxy .*: core\(\), requestOraclePool\(\), or gasLimit\(\) call failed/,
    );
  });
});
