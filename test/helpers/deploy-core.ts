export async function deployConfiguredCore(
  ethers: any,
  authority: any,
  {
    accountingChainId,
    initializeCrossChain = true,
  }: { accountingChainId?: bigint; initializeCrossChain?: boolean } = {},
) {
  const ADAPTER_GATEWAY_MODULE_ID = ethers.id("ufarm.vault.module.adapter-gateway");
  const ADMIN_CONFIG_MODULE_ID = ethers.id("ufarm.vault.module.admin-config");
  const LIFECYCLE_MODULE_ID = ethers.id("ufarm.vault.module.lifecycle");
  const coreImpl = await ethers.deployContract("UFarmCore");
  const coreInitData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
  const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), coreInitData]);
  const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());

  const escrowImpl = await ethers.deployContract("UFarmEscrow");
  const escrowInitData = escrowImpl.interface.encodeFunctionData("initialize", [await core.getAddress()]);
  const escrowProxy = await ethers.deployContract("ERC1967Proxy", [await escrowImpl.getAddress(), escrowInitData]);

  const createX = await ethers.deployContract("MockCreateX");
  const curatorImpl = await ethers.deployContract("UFarmCurator");
  const vaultImpl = await ethers.deployContract("UFarmVault");
  const adapterGatewayModule = await ethers.deployContract("VaultAdapterGatewayModule");
  const adminConfigModule = await ethers.deployContract("VaultAdminConfigModule");
  const lifecycleModule = await ethers.deployContract("VaultLifecycleModule");
  const curatorBeacon = await ethers.deployContract("UpgradeableBeacon", [
    await curatorImpl.getAddress(),
    authority.address,
  ]);
  const vaultBeacon = await ethers.deployContract("UpgradeableBeacon", [
    await vaultImpl.getAddress(),
    authority.address,
  ]);

  await core.initializeFactory(
    await escrowProxy.getAddress(),
    await createX.getAddress(),
    await curatorBeacon.getAddress(),
    await vaultBeacon.getAddress(),
  );
  if (initializeCrossChain) {
    await core.initializeCrossChain(accountingChainId ?? 31337n);
  }
  await core.setVaultModule(ADAPTER_GATEWAY_MODULE_ID, await adapterGatewayModule.getAddress());
  await core.setVaultModule(ADMIN_CONFIG_MODULE_ID, await adminConfigModule.getAddress());
  await core.setVaultModule(LIFECYCLE_MODULE_ID, await lifecycleModule.getAddress());

  return {
    core,
    coreImpl,
    coreProxy,
    escrowProxy,
    createX,
    curatorBeacon,
    vaultBeacon,
    curatorImpl,
    vaultImpl,
    adapterGatewayModule,
    adminConfigModule,
    lifecycleModule,
  };
}
