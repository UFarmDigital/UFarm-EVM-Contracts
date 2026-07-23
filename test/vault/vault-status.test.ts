import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const VAULT_CUSTOMER_MANAGER = 1n << 3n;
const RequestState = { Pending: 6n };

const VaultStatus = {
  Active: 0n,
  Terminated: 1n,
};

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, owner, receiver, settleManager, outsider] =
    await ethers.getSigners();
  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const customAsset = await ethers.deployContract("MockERC20", ["Euro Coin", "EUROC", 18]);

  await core.setPermissionMask(registrar.address, MEMBER | 1n);
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, customAsset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("status-curator"));
  const curatorReceipt = await curatorTx.wait();
  const curatorEvent = curatorReceipt!.logs
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
      ethers.id("status-vault"),
      vaultOwner.address,
      "UFarm Status Vault",
      "uSTATUS",
      await asset.getAddress(),
    );
  const vaultReceipt = await vaultTx.wait();
  const vaultEvent = vaultReceipt!.logs
    .map((log) => {
      try {
        return curator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "VaultCreated");
  const vault = await ethers.getContractAt("UFarmVault", vaultEvent!.args.vault as string);

  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
  await core.setNavRequestCooldown(1n);
  await vault
    .connect(vaultOwner)
    .setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

  for (const account of [owner, receiver]) {
    await asset.mint(account.address, 1_000n);
    await asset.connect(account).approve(await escrow.getAddress(), 1_000n);
    await customAsset.mint(account.address, 1_000n);
    await customAsset.connect(account).approve(await escrow.getAddress(), 1_000n);
  }

  return {
    core,
    escrow,
    oracle,
    asset,
    customAsset,
    vault,
    vaultOwner,
    owner,
    receiver,
    settleManager,
    outsider,
  };
}

async function settle(vault: any, oracle: any, settleManager: any, nav: bigint) {
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
  await vault.connect(settleManager).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const callbackBlock = await ethers.provider.getBlock("latest");
  await oracle.submitNav(requestId, nav, BigInt(callbackBlock!.timestamp + 1));
}

async function seedShares(fixture: Awaited<ReturnType<typeof deployFixture>>, amount: bigint) {
  const { vault, oracle, owner, settleManager } = fixture;
  await vault.connect(owner).requestDeposit(amount, owner.address, owner.address);
  await settle(vault, oracle, settleManager, amount);
  await vault.connect(owner).deposit(0n, owner.address, owner.address);
}

describe("UFarmVault status", function () {
  it("starts active and allows only the owner to terminate it once", async function () {
    const { vault, vaultOwner, outsider } = await deployFixture();

    expect(await vault.status()).to.equal(VaultStatus.Active);
    await expect(vault.connect(outsider).terminate())
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await expect(vault.connect(vaultOwner).terminate()).to.emit(vault, "VaultTerminated").withArgs(vaultOwner.address);
    expect(await vault.status()).to.equal(VaultStatus.Terminated);

    await expect(vault.connect(vaultOwner).terminate()).to.be.revertedWithCustomError(vault, "VaultNotActive");
  });

  it("blocks direct, custom, and signed deposit requests after termination", async function () {
    const { vault, vaultOwner, owner, customAsset, settleManager } = await deployFixture();
    await vault.connect(vaultOwner).terminate();

    await expect(vault.connect(owner).requestDeposit(100n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "VaultNotActive",
    );

    await expect(
      vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
        await customAsset.getAddress(),
        100n,
        owner.address,
        owner.address,
        { signature: "0x", validTill: 0n, tier: 0n },
      ),
    ).to.be.revertedWithCustomError(vault, "VaultNotActive");

    const signedDeposit = {
      request: {
        asset: await customAsset.getAddress(),
        amount: 100n,
        minOutputAmount: 0n,
        controller: owner.address,
        owner: owner.address,
      },
      nonce: 0n,
      deadline: 0n,
      signature: "0x",
    };
    await expect(
      vault
        .connect(settleManager)
        .getFunction(
          "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])",
        )([signedDeposit], []),
    ).to.be.revertedWithCustomError(vault, "VaultNotActive");
    expect(await vault.requestNonces(owner.address)).to.equal(0n);
  });

  it("allows settled deposit claims after termination and blocks termination with pending deposits", async function () {
    const settledFixture = await deployFixture();
    await settledFixture.vault
      .connect(settledFixture.owner)
      .requestDeposit(100n, settledFixture.owner.address, settledFixture.owner.address);
    await settle(settledFixture.vault, settledFixture.oracle, settledFixture.settleManager, 100n);
    await settledFixture.vault.connect(settledFixture.vaultOwner).terminate();

    await expect(
      settledFixture.vault
        .connect(settledFixture.owner)
        .deposit(0n, settledFixture.owner.address, settledFixture.owner.address),
    )
      .to.emit(settledFixture.vault, "DepositClaimed")
      .withArgs(settledFixture.owner.address, 100n);

    const pendingFixture = await deployFixture();
    await pendingFixture.vault
      .connect(pendingFixture.owner)
      .requestDeposit(75n, pendingFixture.owner.address, pendingFixture.owner.address);
    await expect(pendingFixture.vault.connect(pendingFixture.vaultOwner).terminate())
      .to.be.revertedWithCustomError(pendingFixture.vault, "RequestStateError")
      .withArgs(RequestState.Pending);

    await expect(pendingFixture.vault.connect(pendingFixture.owner).cancelDeposit(pendingFixture.owner.address))
      .to.emit(pendingFixture.vault, "DepositCancelled")
      .withArgs(pendingFixture.owner.address, await pendingFixture.asset.getAddress(), 75n);
    await expect(pendingFixture.vault.connect(pendingFixture.vaultOwner).terminate())
      .to.emit(pendingFixture.vault, "VaultTerminated")
      .withArgs(pendingFixture.vaultOwner.address);
  });

  it("blocks termination with pending redeems and allows redeem wind-down after termination", async function () {
    const fixture = await deployFixture();
    const { vault, oracle, owner, settleManager, vaultOwner } = fixture;
    await seedShares(fixture, 200n);

    await vault.connect(owner).requestRedeem(100n, owner.address, owner.address);
    await expect(vault.connect(vaultOwner).terminate())
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.Pending);
    await vault.connect(owner).cancelRedeem(owner.address);

    await vault.connect(vaultOwner).terminate();
    await vault.connect(owner).requestRedeem(100n, owner.address, owner.address);
    await settle(vault, oracle, settleManager, 200n);

    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(100n);

    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await fixture.asset.getAddress(), 100n);
  });
});
