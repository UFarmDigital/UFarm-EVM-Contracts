import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const LIFECYCLE_MODULE_ID = "0xeea8ac09ede26e7635ef12b2766c4400e985224fc39011804f9da5463f497de8";

export default buildModule("VaultLifecycleReplacement", (m) => {
  const core = m.contractAt("UFarmCore", m.getParameter("core"));
  const lifecycle = m.contract("VaultLifecycleModule");

  m.call(core, "setVaultModule", [LIFECYCLE_MODULE_ID, lifecycle]);

  return { lifecycle };
});
