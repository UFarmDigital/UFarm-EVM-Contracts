import { ZeroAddress, id } from "ethers";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ARBITRARY_ADAPTER_ID = id("ufarm.adapter.arbitrary");
const CROSS_CHAIN_ADAPTER_ID = id("ufarm.adapter.cross-chain");

const FoundationAdaptersModule = buildModule("FoundationAdapters", (m) => {
  const coreAddress = m.getParameter("core");
  const core = m.contractAt("UFarmCore", coreAddress, { id: "UFarmCore" });
  const crossChainRouter = m.getParameter("crossChainRouter", ZeroAddress);
  const crossChainFeeToken = m.getParameter("crossChainFeeToken", ZeroAddress);
  const crossChainToken = m.getParameter("crossChainToken", ZeroAddress);
  const crossChainGasLimit = m.getParameter("crossChainGasLimit", 500_000n);
  const ccipChainId = m.getParameter("ccipChainId", 31339n);
  const ccipSelector = m.getParameter("ccipSelector", 1_606_861_706_215_706_843n);

  const arbitraryAdapterGuardImplementation = m.contract("ArbitraryAdapterGuard", [core], {
    id: "ArbitraryAdapterGuardImpl",
  });
  const guardInitData = m.encodeFunctionCall(arbitraryAdapterGuardImplementation, "initialize", []);
  const arbitraryAdapterGuardProxy = m.contract("ERC1967Proxy", [arbitraryAdapterGuardImplementation, guardInitData], {
    id: "ArbitraryAdapterGuardProxy",
    after: [arbitraryAdapterGuardImplementation],
  });
  const arbitraryAdapterGuard = m.contractAt("ArbitraryAdapterGuard", arbitraryAdapterGuardProxy, {
    id: "ArbitraryAdapterGuard",
  });

  const arbitraryAdapter = m.contract("ArbitraryAdapter", [arbitraryAdapterGuard], {
    id: "ArbitraryAdapter",
    after: [arbitraryAdapterGuardProxy],
  });
  const setArbitraryAdapter = m.call(core, "setVaultAdapter", [ARBITRARY_ADAPTER_ID, ZeroAddress, arbitraryAdapter], {
    id: "SetWildcardArbitraryAdapter",
    after: [arbitraryAdapter],
  });
  const crossChainAdapter = m.contract("CrossChainAdapter", [], {
    id: "CrossChainAdapter",
    after: [setArbitraryAdapter],
  });
  const setCrossChainAdapter = m.call(
    core,
    "setVaultAdapter",
    [CROSS_CHAIN_ADAPTER_ID, ZeroAddress, crossChainAdapter],
    {
      id: "SetWildcardCrossChainAdapter",
      after: [crossChainAdapter],
    },
  );
  const setCrossChainRouter = m.call(core, "setCrossChainRouter", [crossChainRouter], {
    id: "SetCrossChainRouter",
    after: [setCrossChainAdapter],
  });
  const setCrossChainFeeToken = m.call(core, "setCrossChainFeeToken", [crossChainFeeToken], {
    id: "SetCrossChainFeeToken",
    after: [setCrossChainRouter],
  });
  const setCrossChainToken = m.call(core, "setCrossChainToken", [crossChainToken], {
    id: "SetCrossChainToken",
    after: [setCrossChainFeeToken],
  });
  const setCrossChainGasLimit = m.call(core, "setCrossChainGasLimit", [crossChainGasLimit], {
    id: "SetCrossChainGasLimit",
    after: [setCrossChainToken],
  });
  m.call(core, "setCCIPSelector", [ccipChainId, ccipSelector], {
    id: "SetCCIPSelector",
    after: [setCrossChainGasLimit],
  });

  return {
    arbitraryAdapterGuard,
    arbitraryAdapter,
    crossChainAdapter,
  };
});

export default FoundationAdaptersModule;
