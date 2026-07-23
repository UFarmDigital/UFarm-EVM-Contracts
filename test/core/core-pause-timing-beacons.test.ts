import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

const NAV_REQUEST_COOLDOWN_PARAMETER = ethers.id("NAV_REQUEST_COOLDOWN");
const ORACLE_REQUEST_TIMEOUT_PARAMETER = ethers.id("ORACLE_REQUEST_TIMEOUT");
const OWNER = 1n << 255n;
const ADMIN = 1n << 254n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const CORE_ADAPTER_MANAGER = 1n << 3n;
const CORE_PAUSE_MANAGER = 1n << 4n;
const CoreConfig = { InvalidFee: 1n };

async function deployCore() {
  const [authority, other] = await ethers.getSigners();
  const configured = await deployConfiguredCore(ethers, authority);
  return { ...configured, authority, other };
}

describe("UFarmCore pause, timing, permissions, and beacons", function () {
  it("stores global and curator pause masks", async function () {
    const { core } = await deployCore();
    const curator = "0x0000000000000000000000000000000000000e01";

    await expect(core.setCuratorPauseMask(ethers.ZeroAddress, 5n)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );
    await expect(core.setGlobalPauseMask(3n)).to.emit(core, "GlobalPauseMaskUpdated").withArgs(3n);
    await expect(core.setCuratorPauseMask(curator, 5n)).to.emit(core, "CuratorPauseMaskUpdated").withArgs(curator, 5n);

    expect(await core.globalPauseMask()).to.equal(3n);
    expect(await core.curatorPauseMask(curator)).to.equal(5n);
  });

  it("stores cooldown and timeout", async function () {
    const { core } = await deployCore();

    expect(await core.navRequestCooldown()).to.equal(300n);
    expect(await core.oracleRequestTimeout()).to.equal(300n);

    await expect(core.setNavRequestCooldown(0n)).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(core.setOracleRequestTimeout(0n)).to.be.revertedWithCustomError(core, "InvalidConfig");

    await expect(core.setNavRequestCooldown(300n))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(NAV_REQUEST_COOLDOWN_PARAMETER, 300n);
    await expect(core.setOracleRequestTimeout(3600n))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(ORACLE_REQUEST_TIMEOUT_PARAMETER, 3600n);

    expect(await core.navRequestCooldown()).to.equal(300n);
    expect(await core.oracleRequestTimeout()).to.equal(3600n);
  });

  it("stores protocol fee with authority and cap checks", async function () {
    const { core, authority, other } = await deployCore();
    const maxProtocolFee = 100_000_000_000_000_000n;
    const vaultAddress = ethers.getAddress("0x0000000000000000000000000000000000000B04");

    expect(await core.protocolFee(vaultAddress)).to.deep.equal([0n, false]);

    await expect(core.connect(other).setProtocolFee(vaultAddress, 1n, false))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);
    await expect(core.connect(other).clearProtocolFee(vaultAddress))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);

    await expect(core.connect(authority).setProtocolFee(vaultAddress, maxProtocolFee + 1n, false))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.InvalidFee);

    await expect(core.connect(authority).setProtocolFee(vaultAddress, maxProtocolFee, false))
      .to.emit(core, "ProtocolFeeUpdated")
      .withArgs(vaultAddress, maxProtocolFee, false, true);

    expect(await core.protocolFee(vaultAddress)).to.deep.equal([maxProtocolFee, false]);

    await expect(core.connect(authority).setProtocolFee(vaultAddress, 1n, true))
      .to.emit(core, "ProtocolFeeUpdated")
      .withArgs(vaultAddress, 1n, true, true);
    expect(await core.protocolFee(vaultAddress)).to.deep.equal([1n, true]);

    await expect(core.connect(authority).clearProtocolFee(vaultAddress))
      .to.emit(core, "ProtocolFeeUpdated")
      .withArgs(vaultAddress, 0n, false, false);
    expect(await core.protocolFee(vaultAddress)).to.deep.equal([0n, false]);
  });

  it("stores account permission masks", async function () {
    const { core, other } = await deployCore();

    await expect(core.setPermissionMask(ethers.ZeroAddress, 9n)).to.be.revertedWithCustomError(core, "InvalidAddress");
    await expect(core.setPermissionMask(other.address, 9n))
      .to.emit(core, "PermissionUpdated")
      .withArgs(other.address, 9n);
    expect(await core.permissionMask(other.address)).to.equal(9n);
    expect(await core.accountHasPermission(other.address, 8n)).to.equal(true);
    expect(await core.accountHasPermission(other.address, 9n)).to.equal(true);
    expect(await core.accountHasPermission(other.address, 11n)).to.equal(false);
    expect(await core.accountHasAnyPermission(other.address, 11n)).to.equal(true);
    expect(await core.accountHasAnyPermission(other.address, 2n)).to.equal(false);
    expect(await core.accountHasAnyPermission(other.address, 0n)).to.equal(false);
    expect(await core.accountHasPermission(other.address, 4n)).to.equal(false);
    expect(await core.accountHasPermission(other.address, 0n)).to.equal(false);
  });

  it("allows admins to update permissions except the owner flag", async function () {
    const { core } = await deployCore();
    const [, admin, target, ownerLike] = await ethers.getSigners();

    await core.setPermissionMask(admin.address, ADMIN);
    await expect(core.connect(admin).setPermissionMask(target.address, 9n))
      .to.emit(core, "PermissionUpdated")
      .withArgs(target.address, 9n);

    await expect(core.connect(admin).setPermissionMask(target.address, OWNER))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(admin.address);

    await core.setPermissionMask(ownerLike.address, OWNER);
    await expect(core.connect(admin).setPermissionMask(ownerLike.address, OWNER | 1n))
      .to.emit(core, "PermissionUpdated")
      .withArgs(ownerLike.address, OWNER | 1n);
  });

  it("uses explicit operational permissions for non-owner core methods, including pricing config", async function () {
    const { core, other } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const feed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);

    await core.setPermissionMask(other.address, (1n << 253n) | CORE_CONFIG_MANAGER);
    await expect(
      core
        .connect(other)
        .setValueTokenConfig(
          await asset.getAddress(),
          await feed.getAddress(),
          86400n,
          990000000000000000n,
          1010000000000000000n,
        ),
    ).to.emit(core, "ValueTokenUpdated");
    await expect(core.connect(other).clearValueTokenConfig(await asset.getAddress())).to.emit(
      core,
      "ValueTokenUpdated",
    );
    await expect(core.connect(other).setProtocolFee(ethers.ZeroAddress, 1n, false)).to.emit(core, "ProtocolFeeUpdated");
    await expect(core.connect(other).clearProtocolFee(ethers.ZeroAddress)).to.emit(core, "ProtocolFeeUpdated");
    await expect(core.connect(other).setNavRequestCooldown(1n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);

    await core.setPermissionMask(other.address, CORE_PAUSE_MANAGER);
    await expect(core.connect(other).setGlobalPauseMask(1n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);

    await core.setPermissionMask(
      other.address,
      (1n << 253n) | CORE_ORACLE_MANAGER | CORE_ADAPTER_MANAGER | CORE_PAUSE_MANAGER,
    );
    await expect(core.connect(other).setNavRequestCooldown(1n)).to.emit(core, "CoreParameterUpdated");
    await expect(core.connect(other).setVaultOracle(ethers.ZeroAddress, other.address)).to.emit(
      core,
      "VaultOracleUpdated",
    );
    await expect(
      core.connect(other).setVaultAdapter(ethers.id("A"), ethers.ZeroAddress, other.address),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");
    const adapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("core-adapter")]);
    await expect(
      core.connect(other).setVaultAdapter(ethers.id("A"), ethers.ZeroAddress, await adapter.getAddress()),
    ).to.emit(core, "VaultAdapterUpdated");
    await expect(core.connect(other).setGlobalPauseMask(1n)).to.emit(core, "GlobalPauseMaskUpdated");
    await expect(core.connect(other).setProtocolFee(ethers.ZeroAddress, 2n, false))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);
  });

  it("stores immutable factory and beacon addresses from initialization", async function () {
    const { core, escrowProxy, createX, curatorBeacon, vaultBeacon } = await deployCore();

    expect(await core.escrow()).to.equal(await escrowProxy.getAddress());
    expect(await core.deterministicDeployer()).to.equal(await createX.getAddress());
    expect(await core.curatorBeacon()).to.equal(await curatorBeacon.getAddress());
    expect(await core.vaultBeacon()).to.equal(await vaultBeacon.getAddress());

    await expect(
      core.initializeFactory(
        await escrowProxy.getAddress(),
        await createX.getAddress(),
        await curatorBeacon.getAddress(),
        await vaultBeacon.getAddress(),
      ),
    ).to.be.revertedWithCustomError(core, "InvalidInitialization");
  });

  it("validates finance vault inputs before forwarding to vaults", async function () {
    const { core, other, vaultImpl } = await deployCore();

    await expect(core.setVaultOperator(ethers.ZeroAddress, other.address, true)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );
    await expect(core.claimVaultRedeem(ethers.ZeroAddress, other.address)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );
    await expect(core.requestVaultRedeem(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      core,
      "InvalidAddress",
    );

    await expect(
      core.setVaultOperator(await vaultImpl.getAddress(), other.address, true),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(core.claimVaultRedeem(await vaultImpl.getAddress(), other.address)).to.be.revertedWithCustomError(
      core,
      "InvalidConfig",
    );
    await expect(core.requestVaultRedeem(await vaultImpl.getAddress(), 1n)).to.be.revertedWithCustomError(
      core,
      "InvalidConfig",
    );
  });

  it("rejects core finance forwarding to vaults outside registered curator ownership", async function () {
    const { core, other, vaultImpl } = await deployCore();
    const [, , vaultOwner, operator] = await ethers.getSigners();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const feed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);
    await core.setValueTokenConfig(
      await asset.getAddress(),
      await feed.getAddress(),
      86400n,
      990000000000000000n,
      1010000000000000000n,
    );

    const initData = vaultImpl.interface.encodeFunctionData("initialize", [
      await core.getAddress(),
      other.address,
      vaultOwner.address,
      ethers.id("unregistered-curator-vault"),
      "Unregistered Curator Vault",
      "uBAD",
      await asset.getAddress(),
    ]);
    const rogueVaultProxy = await ethers.deployContract("ERC1967Proxy", [await vaultImpl.getAddress(), initData]);

    await expect(
      core.setVaultOperator(await rogueVaultProxy.getAddress(), operator.address, true),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.claimVaultRedeem(await rogueVaultProxy.getAddress(), operator.address),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(core.requestVaultRedeem(await rogueVaultProxy.getAddress(), 1n)).to.be.revertedWithCustomError(
      core,
      "InvalidConfig",
    );
  });
});
