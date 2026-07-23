import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const FULL_PERMISSION_MASK = (1n << 256n) - 1n;

const FoundationTimelockModule = buildModule("FoundationTimelock", (m) => {
  const deployer = m.getAccount(0);
  const coreAddress = m.getParameter("core");
  const curatorBeaconAddress = m.getParameter("curatorBeacon");
  const vaultBeaconAddress = m.getParameter("vaultBeacon");
  const timelockMinDelay = m.getParameter("timelockMinDelay", 7n * 24n * 60n * 60n);
  const timelockProposer = m.getParameter("timelockProposer", deployer);
  const timelockExecutor = m.getParameter("timelockExecutor", deployer);
  const timelockAdmin = m.getParameter("timelockAdmin", deployer);

  const core = m.contractAt("UFarmCore", coreAddress, { id: "UFarmCore" });
  const curatorBeacon = m.contractAt("UpgradeableBeacon", curatorBeaconAddress, { id: "UFarmCuratorBeacon" });
  const vaultBeacon = m.contractAt("UpgradeableBeacon", vaultBeaconAddress, { id: "UFarmVaultBeacon" });

  const timelock = m.contract("TimelockController", [
    timelockMinDelay,
    [timelockProposer],
    [timelockExecutor],
    timelockAdmin,
  ]);

  const transferCuratorBeaconOwnership = m.call(curatorBeacon, "transferOwnership", [timelock], {
    id: "TransferCuratorBeaconOwnership",
    after: [timelock],
  });
  const transferVaultBeaconOwnership = m.call(vaultBeacon, "transferOwnership", [timelock], {
    id: "TransferVaultBeaconOwnership",
    after: [transferCuratorBeaconOwnership],
  });
  const grantTimelockOwner = m.call(core, "setPermissionMask", [timelock, FULL_PERMISSION_MASK], {
    id: "GrantTimelockFullPermissions",
    after: [transferVaultBeaconOwnership],
  });
  m.call(core, "setPermissionMask", [deployer, 0n], {
    id: "RevokeDeployerOwnerPermission",
    after: [grantTimelockOwner],
  });

  return { timelock, core, curatorBeacon, vaultBeacon };
});

export default FoundationTimelockModule;
