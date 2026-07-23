import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();
const OracleFlow = {
  Invalid: 1n,
  InvalidRequest: 2n,
  Active: 3n,
  NoneActive: 4n,
  NotTimedOut: 5n,
  Cooldown: 6n,
  InvalidValuationTime: 7n,
};
const VAULT_ASSET_MANAGER = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const SettlementAction = {
  None: 0n,
  Unlock: 1n,
  Cooldown: 2n,
  Lock: 3n,
};

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, assetManager, outsider, receiver] =
    await ethers.getSigners();
  const name = "UFarm Adapter Vault";
  const symbol = "uADAPT";

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());

  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const adapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("POOL_ADAPTER")]);
  const wildcardAdapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("WILDCARD_ADAPTER")]);

  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("adapter-curator"));
  const curatorReceipt = await curatorTx.wait();
  const curatorEvent = curatorReceipt?.logs
    .map((log) => {
      try {
        return core.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CuratorCreated");
  const curator = await ethers.getContractAt("UFarmCurator", curatorEvent!.args.curator as string);

  const vaultTx = await curator
    .connect(curatorOwner)
    .createVault(ethers.id("adapter-vault"), vaultOwner.address, name, symbol, await asset.getAddress());
  const vaultReceipt = await vaultTx.wait();
  const vaultEvent = vaultReceipt?.logs
    .map((log) => {
      try {
        return curator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "VaultCreated");
  const vault = await ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);

  await vault
    .connect(vaultOwner)
    .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_ASSET_MANAGER | VAULT_SETTLE_MANAGER);

  return {
    authority,
    core,
    curator,
    escrow,
    vault,
    oracle,
    asset,
    adapter,
    wildcardAdapter,
    vaultOwner,
    owner,
    assetManager,
    outsider,
    receiver,
  };
}

describe("UFarmVault adapter execution", function () {
  it("executes a wildcard adapter by delegatecall", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_ECHO");
    const callData = adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.None]);

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData))
      .to.emit(vault, "AdapterExecuted")
      .withArgs(adapterId);
  });

  it("uses a vault-specific adapter before the wildcard adapter", async function () {
    const { core, vault, adapter, wildcardAdapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_POOL_SPECIFIC");
    const labelCallData = adapter.interface.encodeFunctionData("label");

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await wildcardAdapter.getAddress());
    await core.setVaultAdapter(adapterId, await vault.getAddress(), await adapter.getAddress());

    await expect(vault.connect(assetManager).executeAdapter(adapterId, labelCallData))
      .to.emit(vault, "AdapterExecuted")
      .withArgs(adapterId);
  });

  it("reverts when adapter resolution is zero or cleared", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_MISSING");
    const callData = adapter.interface.encodeFunctionData("label");

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "InvalidAdapter",
    );

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, ethers.ZeroAddress);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "InvalidAdapter",
    );
  });

  it("requires VAULT_ASSET_MANAGER authorization", async function () {
    const { core, vault, adapter, outsider } = await deployFixture();
    const adapterId = ethers.id("MOCK_AUTH");
    const callData = adapter.interface.encodeFunctionData("label");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

    await expect(vault.connect(outsider).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "Unauthorized",
    );
  });

  it("reverts while full protocol pause is active", async function () {
    const { core, vault, adapter, assetManager, authority } = await deployFixture();
    const adapterId = ethers.id("MOCK_FULL_PAUSE");
    const callData = adapter.interface.encodeFunctionData("label");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.connect(authority).setGlobalPauseMask(1n);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("reverts while adapter execution pause bit is active", async function () {
    const { core, vault, adapter, assetManager, authority } = await deployFixture();
    const adapterId = ethers.id("MOCK_ADAPTER_PAUSE");
    const callData = adapter.interface.encodeFunctionData("label");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.connect(authority).setGlobalPauseMask(1n << 7n);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("reverts while curator pause mask is active", async function () {
    const { core, curator, vault, adapter, assetManager, authority } = await deployFixture();
    const adapterId = ethers.id("MOCK_CURATOR_PAUSE");
    const callData = adapter.interface.encodeFunctionData("label");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("reverts when an oracle request is active", async function () {
    const { core, vault, oracle, adapter, asset, owner, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_ORACLE_ACTIVE");
    const callData = adapter.interface.encodeFunctionData("label");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

    await asset.mint(owner.address, 1n);
    await asset.connect(owner).approve(await vault.escrow(), 1n);
    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
  });

  it("does not adjust settlement allowed timestamp before delegatecall and applies returned cooldown action", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_TIMESTAMP");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setNavRequestCooldown(60n);

    const latest = await ethers.provider.getBlock("latest");
    const nextTimestamp = BigInt(latest!.timestamp + 10);
    const callData = adapter.interface.encodeFunctionData("observedSettlementAllowedAt");
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(nextTimestamp)]);

    await vault.connect(assetManager).executeAdapter(adapterId, callData);

    expect(await vault.settlementAllowedAt()).to.equal(0n);
  });

  it("blocks oracle requests until adapter cooldown action passes", async function () {
    const { core, vault, oracle, asset, adapter, owner, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_COOLDOWN");

    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setNavRequestCooldown(60n);
    await asset.mint(owner.address, 100n);
    await asset.connect(owner).approve(await vault.escrow(), 100n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    const latest = await ethers.provider.getBlock("latest");
    const nextTimestamp = BigInt(latest!.timestamp + 10);
    const settlementAllowedAt = nextTimestamp + 60n;
    const callData = adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Cooldown]);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(nextTimestamp)]);
    await vault.connect(assetManager).executeAdapter(adapterId, callData);
    expect(await vault.settlementAllowedAt()).to.equal(settlementAllowedAt);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);

    await increaseTime(60);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);
  });

  it("keeps max settlement lock when adapter returns cooldown action while locked", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_COOLDOWN_LOCKED");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setNavRequestCooldown(60n);

    await vault
      .connect(assetManager)
      .executeAdapter(adapterId, adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Lock]));
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await vault
      .connect(assetManager)
      .executeAdapter(adapterId, adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Cooldown]));
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("applies unlock action as unconditional cooldown from max settlement lock", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_UNLOCK");
    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
    await core.setNavRequestCooldown(60n);

    await vault
      .connect(assetManager)
      .executeAdapter(adapterId, adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Lock]));
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    const latest = await ethers.provider.getBlock("latest");
    const nextTimestamp = BigInt(latest!.timestamp + 10);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(nextTimestamp)]);
    await vault
      .connect(assetManager)
      .executeAdapter(adapterId, adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Unlock]));
    expect(await vault.settlementAllowedAt()).to.equal(nextTimestamp + 60n);
  });

  it("bubbles adapter revert data and rolls back timestamp update", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_REVERT");
    const callData = adapter.interface.encodeFunctionData("fail", [42n]);

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

    expect(await vault.settlementAllowedAt()).to.equal(0n);
    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData))
      .to.be.revertedWithCustomError(adapter, "MockAdapterFailed")
      .withArgs(42n);
    expect(await vault.settlementAllowedAt()).to.equal(0n);
  });

  it("emits AdapterExecuted with adapter id only", async function () {
    const { core, vault, adapter, assetManager } = await deployFixture();
    const adapterId = ethers.id("MOCK_EVENT");
    const callData = adapter.interface.encodeFunctionData("echoUint256", [1n]);

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());

    const tx = await vault.connect(assetManager).executeAdapter(adapterId, callData);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log) => {
        try {
          return vault.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "AdapterExecuted");

    expect(event).to.not.equal(undefined);
    expect(event!.args.length).to.equal(1);
    expect(event!.args.adapterId).to.equal(adapterId);
  });
});
