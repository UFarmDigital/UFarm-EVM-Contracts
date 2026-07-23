import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const PRIVATE_SETUP_VALUE_TOKEN_SUPPLY = 100_000n * 10n ** 8n;

const PrivateSetupModule = buildModule("PrivateSetup", (m) => {
  const deployer = m.getAccount(0);
  const createX = m.contract("MockCreateX", [], { id: "CreateX" });
  const quexCore = m.contract("MockQuexCore", [], { id: "QuexCore", after: [createX] });
  const quexRequestOraclePool = m.contract("MockQuexRequestOraclePool", [], {
    id: "QuexRequestOraclePool",
    after: [quexCore],
  });
  const ccipRouter = m.contract("MockCCIPRouter", [], { id: "CCIPRouter", after: [quexRequestOraclePool] });
  const valueToken = m.contract("MockERC20", ["USDC", "USDC", 8], { id: "ValueToken", after: [ccipRouter] });
  const valueTokenPriceFeed = m.contract("MockChainlinkAggregator", [8, 100_000_000n], {
    id: "ValueTokenPriceFeed",
    after: [valueToken],
  });

  m.call(valueToken, "mint", [deployer, PRIVATE_SETUP_VALUE_TOKEN_SUPPLY], {
    id: "MintValueTokenToDeployer",
    after: [valueTokenPriceFeed],
  });

  return { createX, quexCore, quexRequestOraclePool, ccipRouter, valueToken, valueTokenPriceFeed };
});

export default PrivateSetupModule;
