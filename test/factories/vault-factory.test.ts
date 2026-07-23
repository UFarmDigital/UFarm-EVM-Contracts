import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const OWNER = 1n << 255n;
const FULL_PERMISSION_MASK = (1n << 256n) - 1n;

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, staff, outsider, otherCuratorOwner] =
    await ethers.getSigners();

  const { core, createX } = await deployConfiguredCore(ethers, authority);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("curator-1"));
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
  const curatorAddress = curatorEvent!.args.curator as string;
  const curator = await ethers.getContractAt("UFarmCurator", curatorAddress);

  const otherCuratorTx = await core.connect(registrar).createCurator(otherCuratorOwner.address, ethers.id("curator-2"));
  const otherCuratorReceipt = await otherCuratorTx.wait();
  const otherCuratorEvent = otherCuratorReceipt?.logs
    .map((log) => {
      try {
        return core.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CuratorCreated");
  const otherCuratorAddress = otherCuratorEvent!.args.curator as string;
  const otherCurator = await ethers.getContractAt("UFarmCurator", otherCuratorAddress);

  return { core, curator, otherCurator, curatorOwner, otherCuratorOwner, vaultOwner, staff, outsider, createX, asset };
}

describe("UFarmCurator vault factory", function () {
  it("lets owner create a vault that resolves escrow through core", async function () {
    const { core, curator, curatorOwner, vaultOwner, asset } = await deployFixture();
    const userSalt = ethers.id("vault-1");
    const vaultName = "UFarm Alpha Vault";
    const vaultSymbol = "uALPHA";
    const predicted = await curator
      .connect(curatorOwner)
      .createVault.staticCall(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());

    const tx = await curator
      .connect(curatorOwner)
      .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());
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

    expect(event).to.not.equal(undefined);
    const vaultAddress = event!.args.vault as string;
    const logicalSalt = event!.args.logicalSalt as string;
    expect(predicted).to.equal(vaultAddress);
    expect(await curator.isVault(vaultAddress)).to.equal(true);

    const vault = await ethers.getContractAt("UFarmVault", vaultAddress);
    expect(await vault.core()).to.equal(await core.getAddress());
    expect(await vault.curator()).to.equal(await curator.getAddress());
    expect(await vault.permissionMask(vaultOwner.address)).to.equal(FULL_PERMISSION_MASK);
    expect(await vault.accountHasPermission(vaultOwner.address, OWNER)).to.equal(true);
    expect(await vault.vaultSalt()).to.equal(logicalSalt);
    expect(await vault.escrow()).to.equal(await core.escrow());
    expect(await vault.name()).to.equal(vaultName);
    expect(await vault.symbol()).to.equal(vaultSymbol);
    expect(await vault.decimals()).to.equal(18n);
    expect(await vault.asset()).to.equal(await asset.getAddress());
  });

  it("lets a curator staff account with creator permission create a vault", async function () {
    const { curator, curatorOwner, staff, vaultOwner, asset } = await deployFixture();
    const vaultName = "UFarm Alpha Vault";
    const vaultSymbol = "uALPHA";
    await curator
      .connect(curatorOwner)
      .setPermissionMask(staff.address, (1n << 253n) | (await curator.CURATOR_VAULT_CREATOR()));

    const tx = await curator
      .connect(staff)
      .createVault(ethers.id("staff-vault"), vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());
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

    expect(event).to.not.equal(undefined);
  });

  it("rejects vault creation from a curator that is not registered in core", async function () {
    const { core, curatorOwner, vaultOwner, asset } = await deployFixture();
    const impl = await ethers.deployContract("UFarmCurator");
    const proxy = await ethers.deployContract("ERC1967Proxy", [
      await impl.getAddress(),
      impl.interface.encodeFunctionData("initialize", [
        await core.getAddress(),
        curatorOwner.address,
        ethers.id("unregistered"),
      ]),
    ]);
    const unregisteredCurator = await ethers.getContractAt("UFarmCurator", await proxy.getAddress());

    await expect(
      unregisteredCurator
        .connect(curatorOwner)
        .createVault(
          ethers.id("unregistered-vault"),
          vaultOwner.address,
          "UFarm Alpha Vault",
          "uALPHA",
          await asset.getAddress(),
        ),
    )
      .to.be.revertedWithCustomError(unregisteredCurator, "CuratorNotRegistered")
      .withArgs(await unregisteredCurator.getAddress());
  });

  it("validates curator finance vault inputs before forwarding to vaults", async function () {
    const { curator, curatorOwner, staff, outsider } = await deployFixture();
    await curator
      .connect(curatorOwner)
      .setPermissionMask(staff.address, (1n << 253n) | (await curator.CURATOR_FINANCE_MANAGER()));

    await expect(
      curator.connect(staff).setVaultOperator(ethers.ZeroAddress, outsider.address, true),
    ).to.be.revertedWithCustomError(curator, "InvalidAddress");
    await expect(
      curator.connect(staff).claimVaultRedeem(ethers.ZeroAddress, outsider.address),
    ).to.be.revertedWithCustomError(curator, "InvalidAddress");
    await expect(curator.connect(staff).requestVaultRedeem(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      curator,
      "InvalidAddress",
    );

    await expect(curator.connect(staff).setVaultOperator(outsider.address, outsider.address, true))
      .to.be.revertedWithCustomError(curator, "VaultNotRegistered")
      .withArgs(outsider.address);
    await expect(curator.connect(staff).claimVaultRedeem(outsider.address, outsider.address))
      .to.be.revertedWithCustomError(curator, "VaultNotRegistered")
      .withArgs(outsider.address);
    await expect(curator.connect(staff).requestVaultRedeem(outsider.address, 1n))
      .to.be.revertedWithCustomError(curator, "VaultNotRegistered")
      .withArgs(outsider.address);
  });

  it("rejects random caller, zero owner, and duplicate salt", async function () {
    const { curator, curatorOwner, outsider, vaultOwner, createX, asset } = await deployFixture();
    const userSalt = ethers.id("dup-salt");
    const vaultName = "UFarm Alpha Vault";
    const vaultSymbol = "uALPHA";

    await expect(
      curator
        .connect(outsider)
        .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress()),
    )
      .to.be.revertedWithCustomError(curator, "Unauthorized")
      .withArgs(outsider.address);

    await expect(
      curator
        .connect(curatorOwner)
        .createVault(userSalt, ethers.ZeroAddress, vaultName, vaultSymbol, await asset.getAddress()),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");

    await expect(
      curator
        .connect(curatorOwner)
        .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");

    await expect(
      curator
        .connect(curatorOwner)
        .createVault(userSalt, vaultOwner.address, "", vaultSymbol, await asset.getAddress()),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");

    await expect(
      curator.connect(curatorOwner).createVault(userSalt, vaultOwner.address, vaultName, "", await asset.getAddress()),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");

    const disabledAsset = await ethers.deployContract("MockERC20", ["Disabled USD", "dUSD", 18]);
    await expect(
      curator
        .connect(curatorOwner)
        .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, await disabledAsset.getAddress()),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");

    await curator
      .connect(curatorOwner)
      .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());
    await expect(
      curator
        .connect(curatorOwner)
        .createVault(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress()),
    ).to.be.revertedWithCustomError(createX, "AlreadyDeployed");
  });

  it("rejects vault creation when the default asset is unconfigured", async function () {
    const { curator, curatorOwner, vaultOwner, createX } = await deployFixture();
    const asset = await ethers.deployContract("MockERC20", ["Unconfigured USD", "uUSD", 18]);

    await expect(
      curator
        .connect(curatorOwner)
        .createVault(
          ethers.id("unconfigured-asset"),
          vaultOwner.address,
          "UFarm Alpha Vault",
          "uALPHA",
          await asset.getAddress(),
        ),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");
  });

  it("rejects vault creation when the default asset price is stale", async function () {
    const { curator, curatorOwner, vaultOwner, core, createX } = await deployFixture();
    const asset = await ethers.deployContract("MockERC20", ["Stale USD", "sUSD", 18]);
    const feed = await configureValueToken(ethers, core, asset, { maxAge: 3600n });
    const latest = await ethers.provider.getBlock("latest");
    await feed.setRoundData(100000000n, BigInt(latest!.timestamp) - 3601n);

    await expect(
      curator
        .connect(curatorOwner)
        .createVault(
          ethers.id("stale-asset"),
          vaultOwner.address,
          "UFarm Alpha Vault",
          "uALPHA",
          await asset.getAddress(),
        ),
    ).to.be.revertedWithCustomError(createX, "DeploymentFailed");
  });

  it("derives different vault addresses for different curators using the same user salt", async function () {
    const { curator, otherCurator, curatorOwner, otherCuratorOwner, vaultOwner, asset } = await deployFixture();
    const userSalt = ethers.id("same-user-salt");
    const vaultName = "UFarm Alpha Vault";
    const vaultSymbol = "uALPHA";
    const first = await curator
      .connect(curatorOwner)
      .createVault.staticCall(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());
    const second = await otherCurator
      .connect(otherCuratorOwner)
      .createVault.staticCall(userSalt, vaultOwner.address, vaultName, vaultSymbol, await asset.getAddress());

    expect(first).to.not.equal(second);
  });
});
