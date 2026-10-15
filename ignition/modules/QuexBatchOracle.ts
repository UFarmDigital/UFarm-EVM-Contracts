import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const QuexBatchOracleModule = buildModule("QuexBatchOracle", (m) => {
  const core = m.getParameter("core");
  const quexCore = m.getParameter("quexCore", "0x97076a3c0A414E779f7BEC2Bd196D4FdaADFDB96");
  const subscriptionId = m.getParameter("subscriptionId", 0n);
  const requestOraclePool = m.getParameter("requestOraclePool");
  const gasLimit = m.getParameter("gasLimit", 1_000_000n);

  const implementation = m.contract("UFarmQuexBatchOracle", [], { id: "UFarmQuexBatchOracleImpl" });
  const initData = m.encodeFunctionCall(implementation, "initialize", [
    core,
    quexCore,
    subscriptionId,
    requestOraclePool,
    gasLimit,
  ]);
  const proxy = m.contract("ERC1967Proxy", [implementation, initData], {
    id: "UFarmQuexBatchOracleProxy",
    after: [implementation],
  });
  const quexBatchOracle = m.contractAt("UFarmQuexBatchOracle", proxy, { id: "UFarmQuexBatchOracle" });
  return { quexBatchOracle };
});

export default QuexBatchOracleModule;
