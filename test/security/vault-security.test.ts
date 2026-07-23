import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const CORE_CURATOR_REGISTRAR = 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const VAULT_CONFIG_MANAGER = 1n << 2n;
const VAULT_CUSTOMER_MANAGER = 1n << 3n;
const OracleFlow = { InvalidRequest: 2n };
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>) {
  return steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
}

async function deployFixture() {
  const [
    authority,
    registrar,
    curatorOwner,
    vaultOwner,
    owner,
    settleManager,
    customerManager,
    configManager,
    outsider,
    beneficiary,
  ] = await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const customAsset = await ethers.deployContract("MockERC20", ["Euro Coin", "EUROC", 18]);

  await core.setPermissionMask(registrar.address, (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER);
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, customAsset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("security-curator"));
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
      ethers.id("security-vault"),
      vaultOwner.address,
      "UFarm Security Vault",
      "uSEC",
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

  await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(customerManager.address, VAULT_CUSTOMER_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(configManager.address, (1n << 253n) | VAULT_CONFIG_MANAGER);

  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);
  await customAsset.mint(owner.address, 1_000_000n);
  await customAsset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);
  await asset.mint(beneficiary.address, 1_000n);
  await asset.connect(beneficiary).approve(await escrow.getAddress(), 1_000n);

  return {
    core,
    vault,
    escrow,
    oracle,
    asset,
    customAsset,
    owner,
    settleManager,
    customerManager,
    configManager,
    outsider,
    beneficiary,
  };
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function increaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const vaultAddress = await vault.getAddress();
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  let oracleAddress = await core.oracleForVault(vaultAddress);
  if (oracleAddress === ethers.ZeroAddress) {
    const [authority] = await ethers.getSigners();
    const oracle = await ethers.deployContract("MockUFarmOracle");
    oracleAddress = await oracle.getAddress();
    await core.connect(authority).setVaultOracle(vaultAddress, oracleAddress);
  }

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

async function seedShares(vault: any, owner: any, settleManager: any, amount: bigint) {
  await vault.connect(owner).requestDeposit(amount, owner.address, owner.address);
  await settleWithOracle(vault, settleManager, amount);
  await vault.connect(owner).deposit(0n, owner.address, owner.address);
}

async function makeClientVerification(
  vault: any,
  signer: any,
  client: string,
  verificationVault: string,
  tier: bigint,
  validTill: bigint,
) {
  const chain = await ethers.provider.getNetwork();
  const signature = await signer.signTypedData(
    {
      name: "UFarmVault",
      version: "2",
      chainId: chain.chainId,
      verifyingContract: await vault.getAddress(),
    },
    {
      ClientVerification: [
        { name: "client", type: "address" },
        { name: "vault", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "validTill", type: "uint64" },
      ],
    },
    { client, vault: verificationVault, tier, validTill },
  );

  return { signature, validTill, tier };
}

describe("UFarmVault security regressions", function () {
  it("rejects customer verification signatures bound to another client or vault", async function () {
    const { vault, customAsset, owner, customerManager, configManager, outsider } = await deployFixture();
    await vault.connect(configManager).setClientTier(2n);

    const requestCustomDeposit = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");
    const validTill = (await nextBlockTimestamp()) + 3600n;

    const otherClientVerification = await makeClientVerification(
      vault,
      customerManager,
      outsider.address,
      await vault.getAddress(),
      2n,
      validTill,
    );
    await expect(
      requestCustomDeposit(await customAsset.getAddress(), 10n, owner.address, owner.address, otherClientVerification),
    ).to.be.revert(ethers);

    const otherVaultVerification = await makeClientVerification(
      vault,
      customerManager,
      owner.address,
      outsider.address,
      2n,
      validTill,
    );
    await expect(
      requestCustomDeposit(await customAsset.getAddress(), 10n, owner.address, owner.address, otherVaultVerification),
    ).to.be.revert(ethers);
  });

  it("rejects replayed oracle callbacks and stale callbacks after resetRequests", async function () {
    const { core, vault, oracle, owner, settleManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(settleManager).getFunction("settleRequests()")();

    const firstTimestamp = await nextBlockTimestamp();
    await oracle.submitNav(1n, 100n, firstTimestamp);
    const replayAllowedAt = await vault.settlementAllowedAt();
    const replayLatest = await ethers.provider.getBlock("latest");
    if (replayAllowedAt > BigInt(replayLatest!.timestamp)) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(replayAllowedAt)]);
    }
    await expect(oracle.submitNav(1n, 100n, firstTimestamp + 1n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(owner).requestDeposit(50n, owner.address, owner.address);
    const settlementAllowedAt = await vault.settlementAllowedAt();
    const latest = await ethers.provider.getBlock("latest");
    if (settlementAllowedAt > BigInt(latest!.timestamp)) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
    }
    await vault.connect(settleManager).getFunction("settleRequests()")();
    await core.setOracleRequestTimeout(1n);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(settleManager).resetRequests();

    await expect(oracle.submitNav(2n, 50n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
  });

  it("rejects unauthorized escrow release even when beneficiary has balance", async function () {
    const { escrow, vault, asset, beneficiary, outsider } = await deployFixture();
    await vault.connect(beneficiary).requestDeposit(100n, beneficiary.address, beneficiary.address);

    const [escrowAmount] = await escrow.balanceOf(
      await vault.getAddress(),
      await asset.getAddress(),
      beneficiary.address,
    );
    expect(escrowAmount).to.equal(100n);

    await expect(
      escrow.connect(outsider).releaseTo(await asset.getAddress(), beneficiary.address, outsider.address, 10n),
    )
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("does not accrue performance fee below high-water mark", async function () {
    const { core, vault, asset, owner, beneficiary, settleManager, configManager } = await deployFixture();

    await vault
      .connect(configManager)
      .setFees(0n, packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedShares(vault, owner, settleManager, 1_000n);

    await asset.mint(beneficiary.address, 300n);
    await asset.connect(beneficiary).approve(await vault.escrow(), 300n);

    await vault.connect(beneficiary).requestDeposit(100n, beneficiary.address, beneficiary.address);
    await settleWithOracle(vault, settleManager, 1_200n);
    await vault.connect(beneficiary).deposit(0n, beneficiary.address, beneficiary.address);

    const coreSharesAfterIncrease = await vault.balanceOf(await core.getAddress());
    const curatorSharesAfterIncrease = await vault.balanceOf(await vault.curator());
    expect(curatorSharesAfterIncrease).to.be.gt(0n);

    await vault.connect(beneficiary).requestDeposit(100n, beneficiary.address, beneficiary.address);
    await settleWithOracle(vault, settleManager, 900n);
    expect(await vault.balanceOf(await core.getAddress())).to.equal(coreSharesAfterIncrease);
    expect(await vault.balanceOf(await vault.curator())).to.equal(curatorSharesAfterIncrease);

    await vault.connect(beneficiary).deposit(0n, beneficiary.address, beneficiary.address);
    const coreSharesAfterDrawdown = await vault.balanceOf(await core.getAddress());
    const curatorSharesAfterDrawdown = await vault.balanceOf(await vault.curator());

    await vault.connect(beneficiary).requestDeposit(100n, beneficiary.address, beneficiary.address);
    await settleWithOracle(vault, settleManager, 1_200n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(coreSharesAfterDrawdown);
    expect(await vault.balanceOf(await vault.curator())).to.equal(curatorSharesAfterDrawdown);
  });

  it("does not charge AUM fee on pending escrowed deposit assets", async function () {
    const YEAR = 365n * 24n * 60n * 60n;
    const { core, vault, asset, owner, beneficiary, settleManager } = await deployFixture();

    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await seedShares(vault, owner, settleManager, 1_000n);

    await asset.mint(beneficiary.address, 10_000n);
    await asset.connect(beneficiary).approve(await vault.escrow(), 10_000n);
    await vault.connect(beneficiary).requestDeposit(10_000n, beneficiary.address, beneficiary.address);

    await increaseTime(YEAR);
    await settleWithOracle(vault, settleManager, 1_000n);

    expect(await vault.balanceOf(await core.getAddress())).to.be.lte(112n);
  });
});
