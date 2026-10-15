import { expect } from "chai";
import QuexBatchOracleModule from "../../ignition/modules/QuexBatchOracle.js";

describe("QuexBatchOracle Ignition module", function () {
  it("deploys only the batch implementation and proxy", function () {
    expect(QuexBatchOracleModule.id).to.equal("QuexBatchOracle");
    expect(Object.keys(QuexBatchOracleModule.results)).to.deep.equal(["quexBatchOracle"]);
    expect(Array.from(QuexBatchOracleModule.futures, (future) => future.id)).to.deep.equal([
      "QuexBatchOracle#UFarmQuexBatchOracleImpl",
      "QuexBatchOracle#encodeFunctionCall(QuexBatchOracle#UFarmQuexBatchOracleImpl.initialize)",
      "QuexBatchOracle#UFarmQuexBatchOracleProxy",
      "QuexBatchOracle#UFarmQuexBatchOracle",
    ]);
  });
});
