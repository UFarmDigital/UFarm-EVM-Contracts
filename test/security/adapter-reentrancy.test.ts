import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const ADAPTER_ID = ethers.id("ufarm.adapter.arbitrary");
const VAULT_ASSET_MANAGER = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const OracleFlow = {
  Cooldown: 6n,
};

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, receiver, assetManager, settleManager, outsider] =
    await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const adapter = await ethers.deployContract("MockVaultAdapter", [ADAPTER_ID]);
  const reentrantTarget = await ethers.deployContract("MockAdapterReentrantTarget");

  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  await configureValueToken(ethers, core, asset);
  await core.setVaultOracle(ethers.ZeroAddress, await oracle.getAddress());
  await core.setVaultAdapter(ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("reentrant-curator"));
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
    .createVault(
      ethers.id("reentrant-vault"),
      vaultOwner.address,
      "UFarm Reentrant Vault",
      "uREENT",
      await asset.getAddress(),
    );
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

  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, (1n << 253n) | VAULT_ASSET_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER);

  for (const signer of [owner, receiver]) {
    await asset.mint(signer.address, 1_000_000n);
    await asset.connect(signer).approve(await escrow.getAddress(), 1_000_000n);
  }

  return {
    core,
    escrow,
    oracle,
    adapter,
    reentrantTarget,
    vault,
    vaultOwner,
    owner,
    receiver,
    assetManager,
    settleManager,
    outsider,
    asset,
  };
}

async function executeAdapterData(fixture: Awaited<ReturnType<typeof deployFixture>>, adapterData: string) {
  const { assetManager, vault } = fixture;
  return vault.connect(assetManager).executeAdapter(ADAPTER_ID, adapterData, { gasLimit: 5_000_000 });
}

async function executeVaultCallback(fixture: Awaited<ReturnType<typeof deployFixture>>, vaultData: string) {
  const { adapter, reentrantTarget, vault } = fixture;
  const adapterData = adapter.interface.encodeFunctionData("callVault", [
    await reentrantTarget.getAddress(),
    await vault.getAddress(),
    vaultData,
    0n,
  ]);
  return executeAdapterData(fixture, adapterData);
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const vaultAddress = await vault.getAddress();
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  const oracleAddress = await core.oracleForVault(vaultAddress);
  const oracle = await ethers.getContractAt("MockUFarmOracle", oracleAddress);

  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const callbackBlock = await ethers.provider.getBlock("latest");
  return oracle.submitNav(requestId, nav, BigInt(callbackBlock!.timestamp + 1));
}

async function seedClaimedShares(fixture: Awaited<ReturnType<typeof deployFixture>>, holder: any, amount: bigint) {
  const { vault, settleManager } = fixture;
  await vault.connect(holder).requestDeposit(amount, holder.address, holder.address);
  await settleWithOracle(vault, settleManager, amount);
  await vault.connect(holder).deposit(0n, holder.address, holder.address);
}

function vaultCall(fixture: Awaited<ReturnType<typeof deployFixture>>, fragment: string, args: unknown[]) {
  return fixture.vault.interface.encodeFunctionData(fragment, args);
}

describe("UFarmVault adapter reentrancy security", function () {
  it("blocks reentrant oracle settlement start from adapter callback", async function () {
    const fixture = await deployFixture();
    const { reentrantTarget, vault, owner } = fixture;
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await executeVaultCallback(fixture, vaultCall(fixture, "settleRequests()", []));

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
  });

  it("blocks lifecycle mutation reentry from signMessage adapter callback", async function () {
    const fixture = await deployFixture();
    const { core, adapter, reentrantTarget, vault, owner, assetManager } = fixture;
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);
    const vaultData = vaultCall(fixture, "requestDeposit(uint256,address,address)", [
      100n,
      owner.address,
      owner.address,
    ]);
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [await reentrantTarget.getAddress(), await vault.getAddress(), vaultData],
    );

    await core.setVaultAdapter(ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());
    await vault.connect(assetManager).signMessage(ethers.id("REENTRANT_SIGN"), message, { gasLimit: 5_000_000 });

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("blocks nested adapter execution from adapter callback", async function () {
    const fixture = await deployFixture();
    const { adapter, reentrantTarget, vault, vaultOwner } = fixture;
    await vault
      .connect(vaultOwner)
      .setPermissionMask(await reentrantTarget.getAddress(), (1n << 253n) | VAULT_ASSET_MANAGER);
    const nestedData = adapter.interface.encodeFunctionData("echoUint256", [0n]);

    await executeVaultCallback(fixture, vaultCall(fixture, "executeAdapter", [ADAPTER_ID, nestedData]));

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
  });

  it("blocks reentrant deposit request from approved operator during adapter execution", async function () {
    const fixture = await deployFixture();
    const { escrow, reentrantTarget, vault, owner, asset } = fixture;
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);

    await executeVaultCallback(
      fixture,
      vaultCall(fixture, "requestDeposit(uint256,address,address)", [100n, owner.address, owner.address]),
    );

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
  });

  it("blocks reentrant deposit cancellation from approved operator during adapter execution", async function () {
    const fixture = await deployFixture();
    const { escrow, reentrantTarget, vault, owner, asset } = fixture;
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await executeVaultCallback(fixture, vaultCall(fixture, "cancelDeposit", [owner.address]));

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address);
    expect(escrowAmount).to.equal(100n);
  });

  it("blocks reentrant redeem request from approved operator during adapter execution", async function () {
    const fixture = await deployFixture();
    const { reentrantTarget, vault, owner } = fixture;
    await seedClaimedShares(fixture, owner, 100n);
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);

    await executeVaultCallback(fixture, vaultCall(fixture, "requestRedeem", [40n, owner.address, owner.address]));

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
  });

  it("blocks reentrant redeem cancellation from approved operator during adapter execution", async function () {
    const fixture = await deployFixture();
    const { reentrantTarget, vault, owner } = fixture;
    await seedClaimedShares(fixture, owner, 100n);
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await executeVaultCallback(fixture, vaultCall(fixture, "cancelRedeem", [owner.address]));

    expect(await reentrantTarget.lastSuccess()).to.equal(false);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(40n);
  });

  it("keeps claim paths callable during adapter callback because settled claims do not change NAV custody", async function () {
    const fixture = await deployFixture();
    const { adapter, asset, escrow, reentrantTarget, vault, owner, receiver, settleManager } = fixture;
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);
    await seedClaimedShares(fixture, receiver, 100n);
    await vault.connect(receiver).requestRedeem(40n, receiver.address, receiver.address);
    await settleWithOracle(vault, settleManager, 100n);
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);
    await vault.connect(receiver).setOperator(await reentrantTarget.getAddress(), true);

    const [receiverClaimableAssets] = await escrow.balanceOf(
      await vault.getAddress(),
      await asset.getAddress(),
      receiver.address,
    );
    const adapterData = adapter.interface.encodeFunctionData("callClaims", [
      await reentrantTarget.getAddress(),
      await vault.getAddress(),
      owner.address,
      receiver.address,
      0n,
    ]);

    const receiverAssetBefore = await asset.balanceOf(receiver.address);
    await executeAdapterData(fixture, adapterData);

    expect(await reentrantTarget.successCount()).to.equal(2n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.claimableRedeemRequest(0n, receiver.address)).to.equal(0n);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverAssetBefore + receiverClaimableAssets);
  });

  it("does not let reset or resend callbacks mutate state during adapter execution", async function () {
    const fixture = await deployFixture();
    const { adapter, reentrantTarget, vault, vaultOwner } = fixture;
    await vault.connect(vaultOwner).setPermissionMask(await reentrantTarget.getAddress(), VAULT_SETTLE_MANAGER);

    const callbackData = adapter.interface.encodeFunctionData("callVaultPair", [
      await reentrantTarget.getAddress(),
      await vault.getAddress(),
      vaultCall(fixture, "resetRequests", []),
      vaultCall(fixture, "manualResendOracleRequest", []),
      0n,
    ]);

    await executeAdapterData(fixture, callbackData);

    expect(await reentrantTarget.successCount()).to.equal(0n);
    expect(await reentrantTarget.failureCount()).to.equal(2n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("blocks multi-step reentrant callback batches during adapter execution", async function () {
    const fixture = await deployFixture();
    const { adapter, reentrantTarget, vault, vaultOwner, owner } = fixture;
    await vault
      .connect(vaultOwner)
      .setPermissionMask(await reentrantTarget.getAddress(), VAULT_ASSET_MANAGER | VAULT_SETTLE_MANAGER);
    await vault.connect(owner).setOperator(await reentrantTarget.getAddress(), true);
    const nestedData = adapter.interface.encodeFunctionData("echoUint256", [0n]);

    const callbackData = adapter.interface.encodeFunctionData("callDepositSettleExecute", [
      await reentrantTarget.getAddress(),
      await vault.getAddress(),
      100n,
      owner.address,
      ADAPTER_ID,
      nestedData,
      0n,
    ]);

    await executeAdapterData(fixture, callbackData);

    expect(await reentrantTarget.successCount()).to.equal(0n);
    expect(await reentrantTarget.failureCount()).to.equal(3n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
  });
});
