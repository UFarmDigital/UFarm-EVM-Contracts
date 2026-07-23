import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ADAPTER_GATEWAY_MODULE_ID = "0x040190e6467ec841fc1665afd3e0f8a904aea0b93762febf53750032a5a38b11";
const ADMIN_CONFIG_MODULE_ID = "0x6b863aa839abbf9566b65d8245ec6703564768071da02556ea87d016c15d092a";
const LIFECYCLE_MODULE_ID = "0xeea8ac09ede26e7635ef12b2766c4400e985224fc39011804f9da5463f497de8";

const FoundationModule = buildModule("Foundation", (m) => {
  const deployer = m.getAccount(0);
  const createXAddress = m.getParameter("createX", "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed");
  const salt = m.getParameter("salt");
  const accountingChainId = m.getParameter("accountingChainId", 1n);
  const quexCore = m.getParameter("quexCore", "0x97076a3c0A414E779f7BEC2Bd196D4FdaADFDB96");
  const quexSubscriptionId = m.getParameter("quexSubscriptionId");

  const createX = m.contractAt("ICreateX", createXAddress, { id: "CreateX" });
  const create3Helper = m.contract("FoundationCreate3Helper", [], { id: "FoundationCreate3Helper" });

  const coreImplementation = m.contract("UFarmCore", [], { id: "UFarmCoreImpl", after: [create3Helper] });
  const initData = m.encodeFunctionCall(coreImplementation, "initialize", [deployer]);
  const coreProxyInitCode = m.staticCall(
    create3Helper,
    "erc1967ProxyInitCode",
    [coreImplementation, initData],
    0,
    { id: "UFarmCoreProxyInitCode" },
  );
  const deployCoreProxy = m.call(createX, "deployCreate3", [salt, coreProxyInitCode], {
    id: "DeployUFarmCoreProxyCreate3",
    after: [coreImplementation],
  });
  const coreProxyAddress = m.staticCall(create3Helper, "create3Address", [createXAddress, deployer, salt], 0, {
    id: "UFarmCoreProxyAddress",
    after: [deployCoreProxy],
  });
  const coreProxy = m.contractAt("ERC1967Proxy", coreProxyAddress, { id: "UFarmCoreProxy" });
  const core = m.contractAt("UFarmCore", coreProxy, { id: "UFarmCore" });

  const curatorImplementation = m.contract("UFarmCurator", [], {
    id: "UFarmCuratorImpl",
    after: [coreProxyAddress],
  });
  const vaultImplementation = m.contract("UFarmVault", [], { id: "UFarmVaultImpl", after: [curatorImplementation] });
  const adapterGatewayModule = m.contract("VaultAdapterGatewayModule", [], {
    id: "VaultAdapterGatewayModule",
    after: [vaultImplementation],
  });
  const adminConfigModule = m.contract("VaultAdminConfigModule", [], {
    id: "VaultAdminConfigModule",
    after: [adapterGatewayModule],
  });
  const lifecycleModule = m.contract("VaultLifecycleModule", [], {
    id: "VaultLifecycleModule",
    after: [adminConfigModule],
  });
  const escrowImplementation = m.contract("UFarmEscrow", [], {
    id: "UFarmEscrowImpl",
    after: [lifecycleModule],
  });
  const quexOracleImplementation = m.contract("UFarmQuexOracle", [], {
    id: "UFarmQuexOracleImpl",
    after: [escrowImplementation],
  });
  const quexOracleInitData = m.encodeFunctionCall(quexOracleImplementation, "initialize", [
    core,
    quexCore,
    quexSubscriptionId,
  ]);
  const quexOracleProxy = m.contract("ERC1967Proxy", [quexOracleImplementation, quexOracleInitData], {
    id: "UFarmQuexOracleProxy",
    after: [quexOracleImplementation],
  });
  const quexOracle = m.contractAt("UFarmQuexOracle", quexOracleProxy, { id: "UFarmQuexOracle" });

  const escrowInitData = m.encodeFunctionCall(escrowImplementation, "initialize", [core]);
  const escrowProxy = m.contract("ERC1967Proxy", [escrowImplementation, escrowInitData], {
    id: "UFarmEscrowProxy",
    after: [quexOracleProxy],
  });
  const escrow = m.contractAt("UFarmEscrow", escrowProxy, { id: "UFarmEscrow" });

  const curatorBeacon = m.contract("UpgradeableBeacon", [curatorImplementation, deployer], {
    id: "UFarmCuratorBeacon",
    after: [escrowProxy],
  });
  const vaultBeacon = m.contract("UpgradeableBeacon", [vaultImplementation, deployer], {
    id: "UFarmVaultBeacon",
    after: [curatorBeacon],
  });

  const initializeFactory = m.call(core, "initializeFactory", [escrow, createXAddress, curatorBeacon, vaultBeacon], {
    id: "InitializeFactory",
    after: [vaultBeacon],
  });
  const initializeCrossChain = m.call(core, "initializeCrossChain", [accountingChainId], {
    id: "InitializeCrossChain",
    after: [initializeFactory],
  });
  const setAdapterGatewayModule = m.call(core, "setVaultModule", [ADAPTER_GATEWAY_MODULE_ID, adapterGatewayModule], {
    id: "SetAdapterGatewayModule",
    after: [initializeCrossChain],
  });
  const setAdminConfigModule = m.call(core, "setVaultModule", [ADMIN_CONFIG_MODULE_ID, adminConfigModule], {
    id: "SetAdminConfigModule",
    after: [setAdapterGatewayModule],
  });
  m.call(core, "setVaultModule", [LIFECYCLE_MODULE_ID, lifecycleModule], {
    id: "SetLifecycleModule",
    after: [setAdminConfigModule],
  });

  return {
    core,
    escrow,
    quexOracle,
    curatorBeacon,
    vaultBeacon,
  };
});

export default FoundationModule;
