import { ZeroAddress } from "ethers";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const FoundationCoreConfigModule = buildModule("FoundationCoreConfig", (m) => {
  const coreAddress = m.getParameter("core");
  const core = m.contractAt("UFarmCore", coreAddress, { id: "UFarmCore" });
  const oracle = m.getParameter("oracle");
  const valueToken = m.getParameter("valueToken");
  const valueTokenPriceFeed = m.getParameter("valueTokenPriceFeed");
  const valueTokenMaxPriceAge = m.getParameter("valueTokenMaxPriceAge", 86_400n);
  const valueTokenMinPrice = m.getParameter("valueTokenMinPrice", 950_000_000_000_000_000n);
  const valueTokenMaxPrice = m.getParameter("valueTokenMaxPrice", 1_050_000_000_000_000_000n);
  const oracleRequestTimeout = m.getParameter("oracleRequestTimeout", 300n);
  const navRequestCooldown = m.getParameter("navRequestCooldown", 300n);
  const protocolFee = m.getParameter("protocolFee", 3_000_000_000_000_000n);
  const zeroUFarmFee = m.getParameter("zeroUFarmFee", false);

  const setWildcardOracle = m.call(core, "setVaultOracle", [ZeroAddress, oracle], {
    id: "SetWildcardOracle",
  });
  const setValueTokenConfig = m.call(
    core,
    "setValueTokenConfig",
    [valueToken, valueTokenPriceFeed, valueTokenMaxPriceAge, valueTokenMinPrice, valueTokenMaxPrice],
    {
      id: "SetValueTokenConfig",
      after: [setWildcardOracle],
    },
  );
  const setOracleRequestTimeout = m.call(core, "setOracleRequestTimeout", [oracleRequestTimeout], {
    id: "SetOracleRequestTimeout",
    after: [setValueTokenConfig],
  });
  const setNavRequestCooldown = m.call(core, "setNavRequestCooldown", [navRequestCooldown], {
    id: "SetNavRequestCooldown",
    after: [setOracleRequestTimeout],
  });
  m.call(core, "setProtocolFee", [ZeroAddress, protocolFee, zeroUFarmFee], {
    id: "SetProtocolFee",
    after: [setNavRequestCooldown],
  });

  return { core };
});

export default FoundationCoreConfigModule;
