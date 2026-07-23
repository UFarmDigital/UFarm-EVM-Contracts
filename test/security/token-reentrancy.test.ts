import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const CORE_CURATOR_REGISTRAR = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;

const HookPoint = {
  BeforeTransfer: 1n,
  AfterTransfer: 2n,
  BeforeTransferFrom: 3n,
  AfterTransferFrom: 4n,
};

const emptyVerification = { signature: "0x", validTill: 0n, tier: 0n };

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, secondOwner, thirdOwner, receiver, settleManager] =
    await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const asset = await ethers.deployContract("MockReentrantERC20", ["Malicious USD", "mUSD", 18]);
  const customAsset = await ethers.deployContract("MockReentrantERC20", ["Malicious Euro", "mEUR", 18]);

  await core.setPermissionMask(registrar.address, (1n << 253n) | CORE_CURATOR_REGISTRAR);
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, customAsset);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("token-reentrant-curator"));
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
      ethers.id("token-reentrant-vault"),
      vaultOwner.address,
      "UFarm Token Reentrant Vault",
      "uTOK",
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

  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER);

  for (const signer of [owner, secondOwner, thirdOwner, receiver]) {
    await asset.mint(signer.address, 1_000_000n);
    await asset.connect(signer).approve(await escrow.getAddress(), 1_000_000n);
    await customAsset.mint(signer.address, 1_000_000n);
    await customAsset.connect(signer).approve(await escrow.getAddress(), 1_000_000n);
  }

  return {
    core,
    escrow,
    vault,
    asset,
    customAsset,
    vaultOwner,
    owner,
    secondOwner,
    thirdOwner,
    receiver,
    settleManager,
  };
}

function requestCustomDeposit(vault: any, signer: any, asset: string, assets: bigint, owner: string) {
  return vault.connect(signer).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
    asset,
    assets,
    owner,
    owner,
    emptyVerification,
  );
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const vaultAddress = await vault.getAddress();
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  await core.setVaultOracle(vaultAddress, await oracle.getAddress());

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

async function seedShares(fixture: Awaited<ReturnType<typeof deployFixture>>, holder: any, amount: bigint) {
  const { vault, settleManager } = fixture;
  await vault.connect(holder).requestDeposit(amount, holder.address, holder.address);
  await settleWithOracle(vault, settleManager, amount);
  await vault.connect(holder).deposit(0n, holder.address, holder.address);
}

async function increaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

describe("UFarmVault token and escrow reentrancy security", function () {
  it("keeps a custom deposit pending when token reenters before transferFrom completes", async function () {
    const { escrow, vault, customAsset, owner } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await vault.connect(owner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.BeforeTransferFrom,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("cancelDeposit", [owner.address]),
      1n,
    );

    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    expect(escrowAmount).to.equal(100n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(100n);
  });

  it("keeps a custom deposit pending when token reenters cancelDeposit during transferFrom", async function () {
    const { escrow, vault, customAsset, owner } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await vault.connect(owner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.AfterTransferFrom,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("cancelDeposit", [owner.address]),
      1n,
    );

    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    expect(escrowAmount).to.equal(100n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(100n);
  });

  it("does not create a second deposit request from token reentry during transferFrom", async function () {
    const { escrow, vault, customAsset, owner } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await vault.connect(owner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.AfterTransferFrom,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))", [
        assetAddress,
        25n,
        owner.address,
        owner.address,
        emptyVerification,
      ]),
      1n,
    );

    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    expect(escrowAmount).to.equal(100n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(100n);
  });

  it("does not allow cancelDeposit token transfer reentry to open a new request", async function () {
    const { escrow, vault, customAsset, owner } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);
    await vault.connect(owner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.AfterTransfer,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))", [
        assetAddress,
        50n,
        owner.address,
        owner.address,
        emptyVerification,
      ]),
      1n,
    );

    await vault.connect(owner).cancelDeposit(owner.address);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    expect(escrowAmount).to.equal(0n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("does not allow cancelDeposit before-transfer reentry to open a new request", async function () {
    const { escrow, vault, customAsset, owner } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);
    await vault.connect(owner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.BeforeTransfer,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))", [
        assetAddress,
        50n,
        owner.address,
        owner.address,
        emptyVerification,
      ]),
      1n,
    );

    await vault.connect(owner).cancelDeposit(owner.address);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    const [escrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    expect(escrowAmount).to.equal(0n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("does not let deposit settlement token transfer reentry mutate request queues", async function () {
    const { escrow, vault, customAsset, owner, secondOwner, thirdOwner, settleManager } = await deployFixture();
    const assetAddress = await customAsset.getAddress();
    await requestCustomDeposit(vault, owner, assetAddress, 100n, owner.address);
    await requestCustomDeposit(vault, secondOwner, assetAddress, 100n, secondOwner.address);
    await vault.connect(thirdOwner).setOperator(assetAddress, true);
    await customAsset.setHook(
      HookPoint.AfterTransfer,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))", [
        assetAddress,
        25n,
        thirdOwner.address,
        thirdOwner.address,
        emptyVerification,
      ]),
      1n,
    );

    await settleWithOracle(vault, settleManager, 200n);

    expect(await customAsset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingDepositRequest(0n, thirdOwner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.claimableDepositRequest(0n, secondOwner.address)).to.equal(100n);
    const [thirdEscrowAmount] = await escrow.balanceOf(await vault.getAddress(), assetAddress, thirdOwner.address);
    expect(thirdEscrowAmount).to.equal(0n);
  });

  it("does not let redeem settlement token transferFrom reentry cancel the active redeem", async function () {
    const fixture = await deployFixture();
    const { escrow, vault, asset, owner, settleManager } = fixture;
    const assetAddress = await asset.getAddress();
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await vault.connect(owner).setOperator(assetAddress, true);
    await asset.setHook(
      HookPoint.AfterTransferFrom,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("cancelRedeem", [owner.address]),
      1n,
    );

    await settleWithOracle(vault, settleManager, 100n);

    expect(await asset.lastHookSuccess()).to.equal(false);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("does not double-claim redeem assets when token transfer reenters redeem", async function () {
    const fixture = await deployFixture();
    const { escrow, vault, asset, owner, settleManager } = fixture;
    const assetAddress = await asset.getAddress();
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);
    const [claimableAssets] = await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address);
    const ownerBalanceBefore = await asset.balanceOf(owner.address);
    await vault.connect(owner).setOperator(assetAddress, true);
    await asset.setHook(
      HookPoint.AfterTransfer,
      await vault.getAddress(),
      vault.interface.encodeFunctionData("redeem", [0n, owner.address, owner.address]),
      1n,
    );

    await vault.connect(owner).redeem(0n, owner.address, owner.address);

    expect(await asset.lastHookSuccess()).to.equal(false);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await asset.balanceOf(owner.address)).to.equal(ownerBalanceBefore + claimableAssets);
  });

  it("does not over-withdraw escrow balances when token transfer reenters withdraw", async function () {
    const { escrow, vault, asset, owner, receiver } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const escrowAddress = await escrow.getAddress();
    const vaultAddress = await vault.getAddress();
    await asset.mint(assetAddress, 100n);
    await asset.callTarget(assetAddress, asset.interface.encodeFunctionData("approve", [escrowAddress, 100n]));
    expect(await asset.lastExternalCallSuccess()).to.equal(true);
    await asset.callTarget(vaultAddress, vault.interface.encodeFunctionData("setOperator", [owner.address, true]));
    expect(await asset.lastExternalCallSuccess()).to.equal(true);
    await vault.connect(owner).requestDeposit(100n, assetAddress, assetAddress);
    await increaseTime(7n * 24n * 60n * 60n + 1n);
    const [escrowAmountBefore, lockedTill] = await escrow.balanceOf(vaultAddress, assetAddress, assetAddress);
    const latest = await ethers.provider.getBlock("latest");
    expect(escrowAmountBefore).to.equal(100n);
    expect(lockedTill).to.be.lte(latest!.timestamp);
    await asset.setHook(
      HookPoint.AfterTransfer,
      escrowAddress,
      escrow.interface.encodeFunctionData("withdraw", [vaultAddress, assetAddress, 100n, receiver.address]),
      1n,
    );

    const receiverBalanceBefore = await asset.balanceOf(receiver.address);
    await asset.callTarget(
      escrowAddress,
      escrow.interface.encodeFunctionData("withdraw", [vaultAddress, assetAddress, 100n, receiver.address]),
    );

    expect(await asset.lastExternalCallSuccess()).to.equal(true);
    expect(await asset.lastHookSuccess()).to.equal(false);
    const [escrowAmount] = await escrow.balanceOf(vaultAddress, assetAddress, assetAddress);
    expect(escrowAmount).to.equal(0n);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBefore + 100n);
  });
});
