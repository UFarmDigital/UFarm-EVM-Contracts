import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwnerA, vaultOwnerB, owner, beneficiary, recipient, outsider] =
    await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());

  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);

  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("escrow-curator"));
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

  const createVault = async (salt: string, vaultOwnerAddress: string) => {
    const tx = await curator
      .connect(curatorOwner)
      .createVault(ethers.id(salt), vaultOwnerAddress, "Escrow Test Vault", "esTV", await asset.getAddress());
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log) => {
        try {
          return curator.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "VaultCreated");
    return event!.args.vault as string;
  };

  const vaultA = await createVault("escrow-vault-a", vaultOwnerA.address);
  const vaultB = await createVault("escrow-vault-b", vaultOwnerB.address);

  await asset.mint(owner.address, 1_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000n);

  return {
    core,
    escrow,
    asset,
    owner,
    vaultA,
    vaultB,
    beneficiary,
    recipient,
    outsider,
    curator: await curator.getAddress(),
  };
}

async function asVault(vaultAddress: string) {
  await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x3635C9ADC5DEA00000"]);
  await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
  return await ethers.getSigner(vaultAddress);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployStandaloneVault(
  coreAddress: string,
  curatorAddress: string,
  ownerAddress: string,
  assetAddress: string,
) {
  const vaultImpl = await ethers.deployContract("UFarmVault");
  const initData = vaultImpl.interface.encodeFunctionData("initialize", [
    coreAddress,
    curatorAddress,
    ownerAddress,
    ethers.id(`standalone-vault-${curatorAddress}`),
    "Standalone Vault",
    "sVLT",
    assetAddress,
  ]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await vaultImpl.getAddress(), initData]);
  return await proxy.getAddress();
}

describe("UFarmEscrow custody ledger", function () {
  it("creditFrom scopes balance by calling vault and tracks max lock", async function () {
    const { escrow, asset, owner, vaultA, vaultB, beneficiary } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const lock = 1000;
    const vaultASigner = await asVault(vaultA);

    await expect(
      escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 0n, lock),
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 400n, lock);

    const [amountA, lockA] = await escrow.balanceOf(vaultA, assetAddress, beneficiary.address);
    const [amountB, lockB] = await escrow.balanceOf(vaultB, assetAddress, beneficiary.address);

    expect(amountA).to.equal(400n);
    expect(lockA).to.equal(BigInt(lock));
    expect(amountB).to.equal(0n);
    expect(lockB).to.equal(0n);
    expect(await asset.balanceOf(await escrow.getAddress())).to.equal(400n);
    expect(await asset.balanceOf(owner.address)).to.equal(600n);
  });

  it("releaseTo sends tokens and clears lock when balance becomes zero", async function () {
    const { escrow, asset, owner, vaultA, beneficiary, recipient } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const vaultASigner = await asVault(vaultA);

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 250n, 77);
    await expect(
      escrow.connect(vaultASigner).releaseTo(assetAddress, beneficiary.address, recipient.address, 251n),
    ).to.be.revertedWithCustomError(escrow, "InsufficientLiquidity");
    await expect(
      escrow.connect(vaultASigner).releaseTo(assetAddress, beneficiary.address, recipient.address, 0n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");

    await escrow.connect(vaultASigner).releaseTo(assetAddress, beneficiary.address, recipient.address, 250n);

    const [amount, lock] = await escrow.balanceOf(vaultA, assetAddress, beneficiary.address);
    expect(amount).to.equal(0n);
    expect(lock).to.equal(0n);
    expect(await asset.balanceOf(recipient.address)).to.equal(250n);
  });

  it("releaseToVault releases to vault, keeps lock on partial release, and validates amount bounds", async function () {
    const { escrow, asset, owner, vaultA, beneficiary } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const lock = 5000;
    const vaultASigner = await asVault(vaultA);

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 300n, lock);
    await escrow.connect(vaultASigner).releaseToVault(assetAddress, beneficiary.address, 120n);

    const [amountAfterPartial, lockAfterPartial] = await escrow.balanceOf(vaultA, assetAddress, beneficiary.address);
    expect(amountAfterPartial).to.equal(180n);
    expect(lockAfterPartial).to.equal(BigInt(lock));
    expect(await asset.balanceOf(vaultA)).to.equal(120n);

    await expect(
      escrow.connect(vaultASigner).releaseToVault(assetAddress, beneficiary.address, 181n),
    ).to.be.revertedWithCustomError(escrow, "InsufficientLiquidity");
    await expect(
      escrow.connect(vaultASigner).releaseToVault(assetAddress, beneficiary.address, 0n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("validates zero addresses on registered vault custody paths", async function () {
    const { escrow, asset, owner, vaultA, beneficiary, recipient } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const vaultASigner = await asVault(vaultA);

    await expect(
      escrow.connect(vaultASigner).creditFrom(ethers.ZeroAddress, owner.address, beneficiary.address, 1n, 0),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(vaultASigner).creditFrom(assetAddress, ethers.ZeroAddress, beneficiary.address, 1n, 0),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, ethers.ZeroAddress, 1n, 0),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 10n, 0);

    await expect(
      escrow.connect(vaultASigner).releaseTo(ethers.ZeroAddress, beneficiary.address, recipient.address, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(vaultASigner).releaseTo(assetAddress, ethers.ZeroAddress, recipient.address, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(vaultASigner).releaseTo(assetAddress, beneficiary.address, ethers.ZeroAddress, 1n),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

    await expect(
      escrow.connect(vaultASigner).unlock(ethers.ZeroAddress, beneficiary.address),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(escrow.connect(vaultASigner).unlock(assetAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      escrow,
      "InvalidAddress",
    );
  });

  it("validates withdraw addresses and amount before reading balances", async function () {
    const { escrow, asset, vaultA, beneficiary, recipient } = await deployFixture();
    const assetAddress = await asset.getAddress();

    await expect(
      escrow.connect(beneficiary).withdraw(ethers.ZeroAddress, assetAddress, 1n, recipient.address),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(beneficiary).withdraw(vaultA, ethers.ZeroAddress, 1n, recipient.address),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 1n, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    await expect(
      escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 0n, recipient.address),
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("unlocks beneficiary balance without transferring and lets beneficiary withdraw unlocked assets", async function () {
    const { escrow, asset, owner, vaultA, beneficiary, recipient, outsider } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const vaultASigner = await asVault(vaultA);
    const lockedTill = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 10_000);

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 250n, lockedTill);
    await expect(escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 1n, recipient.address))
      .to.be.revertedWithCustomError(escrow, "AssetLocked")
      .withArgs(lockedTill);

    await expect(escrow.connect(vaultASigner).unlock(assetAddress, beneficiary.address))
      .to.emit(escrow, "EscrowUnlocked")
      .withArgs(vaultA, assetAddress, beneficiary.address, 250n);

    expect(await asset.balanceOf(recipient.address)).to.equal(0n);
    expect(await escrow.balanceOf(vaultA, assetAddress, beneficiary.address)).to.deep.equal([250n, 0n]);

    await expect(
      escrow.connect(outsider).withdraw(vaultA, assetAddress, 1n, recipient.address),
    ).to.be.revertedWithCustomError(escrow, "InsufficientLiquidity");

    await expect(escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 100n, recipient.address))
      .to.emit(escrow, "EscrowWithdrawn")
      .withArgs(vaultA, assetAddress, beneficiary.address, recipient.address, 100n);

    expect(await escrow.balanceOf(vaultA, assetAddress, beneficiary.address)).to.deep.equal([150n, 0n]);
    expect(await asset.balanceOf(recipient.address)).to.equal(100n);
  });

  it("allows beneficiary to withdraw after lock expiry without vault unlock", async function () {
    const { escrow, asset, owner, vaultA, beneficiary, recipient } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const vaultASigner = await asVault(vaultA);
    const lockedTill = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 100);

    await escrow.connect(vaultASigner).creditFrom(assetAddress, owner.address, beneficiary.address, 50n, lockedTill);
    await expect(escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 50n, recipient.address))
      .to.be.revertedWithCustomError(escrow, "AssetLocked")
      .withArgs(lockedTill);

    await increaseTime(101);

    await escrow.connect(beneficiary).withdraw(vaultA, assetAddress, 50n, recipient.address);
    expect(await escrow.balanceOf(vaultA, assetAddress, beneficiary.address)).to.deep.equal([0n, 0n]);
    expect(await asset.balanceOf(recipient.address)).to.equal(50n);
  });

  it("ignores unlock when the beneficiary has no escrow balance", async function () {
    const { escrow, asset, vaultA, beneficiary } = await deployFixture();
    const vaultASigner = await asVault(vaultA);

    await escrow.connect(vaultASigner).unlock(await asset.getAddress(), beneficiary.address);
    expect(await escrow.balanceOf(vaultA, await asset.getAddress(), beneficiary.address)).to.deep.equal([0n, 0n]);
  });

  it("rejects non-vault callers for credit and release entrypoints", async function () {
    const { escrow, asset, owner, beneficiary, recipient, outsider } = await deployFixture();
    const assetAddress = await asset.getAddress();

    await expect(escrow.connect(outsider).creditFrom(assetAddress, owner.address, beneficiary.address, 1n, 0))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(outsider.address);
    await expect(escrow.connect(outsider).releaseTo(assetAddress, beneficiary.address, recipient.address, 1n))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(outsider.address);
    await expect(escrow.connect(outsider).releaseToVault(assetAddress, beneficiary.address, 1n))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("reverts when caller vault curator is not registered in core", async function () {
    const { escrow, asset, owner, beneficiary, outsider } = await deployFixture();
    const assetAddress = await asset.getAddress();
    const rogueVault = await deployStandaloneVault(await escrow.core(), outsider.address, owner.address, assetAddress);
    const rogueVaultSigner = await asVault(rogueVault);

    await expect(escrow.connect(rogueVaultSigner).creditFrom(assetAddress, owner.address, beneficiary.address, 1n, 0))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(rogueVault);
  });

  it("reverts when registered curator does not recognize caller vault", async function () {
    const { core, escrow, asset, owner, beneficiary, curator } = await deployFixture();
    const unknownVault = await deployStandaloneVault(
      await core.getAddress(),
      curator,
      owner.address,
      await asset.getAddress(),
    );
    const unknownVaultSigner = await asVault(unknownVault);

    await asset.mint(owner.address, 2n);
    await asset.connect(owner).approve(await escrow.getAddress(), 2n);

    await expect(
      escrow
        .connect(unknownVaultSigner)
        .creditFrom(await asset.getAddress(), owner.address, beneficiary.address, 1n, 0),
    )
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(unknownVault);
  });
});
