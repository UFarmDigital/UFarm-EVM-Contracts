import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const OWNER = 1n << 255n;
const ADMIN = 1n << 254n;
const FULL_PERMISSION_MASK = (1n << 256n) - 1n;
const VAULT_ASSET_MANAGER = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const VAULT_CONFIG_MANAGER = 1n << 2n;
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>, period = 0n) {
  const schedule = steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
  return schedule | (period << 128n);
}

function interfaceId(signatures: string[]) {
  const id = signatures.reduce((acc, signature) => acc ^ BigInt(ethers.id(signature).slice(0, 10)), 0n);
  return `0x${id.toString(16).padStart(8, "0")}`;
}

async function signOperatorApproval(
  vault: any,
  signer: any,
  owner: string,
  operator: string,
  approved: boolean,
  deadline: bigint,
  nonce: bigint,
  chainIdOverride?: bigint,
  verifyingContractOverride?: string,
  versionOverride = "2",
) {
  const networkInfo = await ethers.provider.getNetwork();
  const domain = {
    name: "UFarmVault",
    version: versionOverride,
    chainId: chainIdOverride ?? networkInfo.chainId,
    verifyingContract: verifyingContractOverride ?? (await vault.getAddress()),
  };
  const types = {
    SetOperator: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = { owner, operator, approved, nonce, deadline };

  return signer.signTypedData(domain, types, value);
}

async function deployFixture() {
  const [authority, registrar, curatorOwner, vaultOwner, operator, admin, outsider, receiver] =
    await ethers.getSigners();
  const name = "UFarm Alpha Vault";
  const symbol = "uALPHA";

  const { core } = await deployConfiguredCore(ethers, authority);
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
  const curator = await ethers.getContractAt("UFarmCurator", curatorEvent!.args.curator as string);

  const vaultTx = await curator
    .connect(curatorOwner)
    .createVault(ethers.id("vault-base"), vaultOwner.address, name, symbol, await asset.getAddress());
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

  return { core, curator, vault, vaultOwner, operator, admin, outsider, receiver, name, symbol, asset };
}

async function deployVaultProxy(impl: any, core: any, curator: string, owner: string, asset: string) {
  const initData = impl.interface.encodeFunctionData("initialize", [
    await core.getAddress(),
    curator,
    owner,
    ethers.id("vault-init"),
    "UFarm Alpha Vault",
    "uALPHA",
    asset,
  ]);

  return ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), initData]);
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const vaultAddress = await vault.getAddress();
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  await core.setVaultOracle(vaultAddress, await oracle.getAddress());

  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const latest = await ethers.provider.getBlock("latest");
  return oracle.submitNav(requestId, nav, BigInt(latest!.timestamp + 1));
}

describe("UFarmVault base", function () {
  it("rejects initialization when the default asset is unconfigured", async function () {
    const [authority, registrar, curatorOwner, vaultOwner] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);
    await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
    const impl = await ethers.deployContract("UFarmVault");

    const curatorTx = await core
      .connect(registrar)
      .createCurator(curatorOwner.address, ethers.id("curator-init-unconfigured"));
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
    const asset = await ethers.deployContract("MockERC20", ["Unconfigured USD", "uUSD", 18]);

    await expect(
      deployVaultProxy(impl, core, curatorEvent!.args.curator as string, vaultOwner.address, await asset.getAddress()),
    ).to.be.revertedWithCustomError(impl, "InvalidAsset");
  });

  it("rejects initialization when the default asset price is stale", async function () {
    const [authority, registrar, curatorOwner, vaultOwner] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);
    await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
    const impl = await ethers.deployContract("UFarmVault");

    const curatorTx = await core
      .connect(registrar)
      .createCurator(curatorOwner.address, ethers.id("curator-init-stale"));
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
    const asset = await ethers.deployContract("MockERC20", ["Stale USD", "sUSD", 18]);
    const feed = await configureValueToken(ethers, core, asset, { maxAge: 3600n });
    const latest = await ethers.provider.getBlock("latest");
    await feed.setRoundData(100000000n, BigInt(latest!.timestamp) - 3601n);

    await expect(
      deployVaultProxy(impl, core, curatorEvent!.args.curator as string, vaultOwner.address, await asset.getAddress()),
    ).to.be.revertedWithCustomError(impl, "InvalidAsset");
  });

  it("returns metadata and basic ERC-20 view state", async function () {
    const { vault, name, symbol, outsider, asset } = await deployFixture();

    expect(await vault.name()).to.equal(name);
    expect(await vault.symbol()).to.equal(symbol);
    expect(await vault.decimals()).to.equal(18n);
    expect(await vault.totalSupply()).to.equal(0n);
    expect(await vault.balanceOf(outsider.address)).to.equal(0n);
    expect(await vault.allowance(outsider.address, outsider.address)).to.equal(0n);
    expect(await vault.asset()).to.equal(await asset.getAddress());
  });

  it("accepts native value transfers", async function () {
    const { vault, outsider } = await deployFixture();
    const vaultAddress = await vault.getAddress();

    await outsider.sendTransaction({ to: vaultAddress, value: 1_000n });

    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(1_000n);
  });

  it("advertises ERC-7540 and ERC-7575 interface support", async function () {
    const { vault } = await deployFixture();

    expect(await vault.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(
      await vault.supportsInterface(interfaceId(["setOperator(address,bool)", "isOperator(address,address)"])),
    ).to.equal(true);
    expect(await vault.supportsInterface(interfaceId(["share()"]))).to.equal(true);
    expect(
      await vault.supportsInterface(
        interfaceId([
          "requestDeposit(uint256,address,address)",
          "pendingDepositRequest(uint256,address)",
          "claimableDepositRequest(uint256,address)",
          "deposit(uint256,address,address)",
        ]),
      ),
    ).to.equal(true);
    expect(
      await vault.supportsInterface(
        interfaceId([
          "requestRedeem(uint256,address,address)",
          "pendingRedeemRequest(uint256,address)",
          "claimableRedeemRequest(uint256,address)",
          "redeem(uint256,address,address)",
        ]),
      ),
    ).to.equal(true);
    expect(await vault.supportsInterface("0x85572ffb")).to.equal(true);
    expect(await vault.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("supports ERC-20 share transfers and allowances", async function () {
    const { vault, vaultOwner, operator, receiver, asset } = await deployFixture();

    await asset.mint(vaultOwner.address, 100n);
    await asset.connect(vaultOwner).approve(await vault.escrow(), 100n);
    await vault.connect(vaultOwner).requestDeposit(100n, vaultOwner.address, vaultOwner.address);
    await vault.connect(vaultOwner).setPermissionMask(receiver.address, VAULT_SETTLE_MANAGER);
    await settleWithOracle(vault, receiver, 100n);
    await vault.connect(vaultOwner).deposit(0n, vaultOwner.address, vaultOwner.address);

    await expect(vault.connect(vaultOwner).transfer(receiver.address, 30n))
      .to.emit(vault, "Transfer")
      .withArgs(vaultOwner.address, receiver.address, 30n);
    expect(await vault.balanceOf(vaultOwner.address)).to.equal(70n);
    expect(await vault.balanceOf(receiver.address)).to.equal(30n);

    await expect(vault.connect(receiver).approve(operator.address, 12n))
      .to.emit(vault, "Approval")
      .withArgs(receiver.address, operator.address, 12n);
    expect(await vault.allowance(receiver.address, operator.address)).to.equal(12n);

    await expect(vault.connect(operator).transferFrom(receiver.address, vaultOwner.address, 7n))
      .to.emit(vault, "Transfer")
      .withArgs(receiver.address, vaultOwner.address, 7n);
    expect(await vault.allowance(receiver.address, operator.address)).to.equal(5n);
    expect(await vault.balanceOf(receiver.address)).to.equal(23n);
    expect(await vault.balanceOf(vaultOwner.address)).to.equal(77n);
  });

  it("restricts only direct transfers of ERC-20 shares when configured", async function () {
    const { vault, vaultOwner, operator, receiver, asset } = await deployFixture();

    await asset.mint(vaultOwner.address, 100n);
    await asset.connect(vaultOwner).approve(await vault.escrow(), 100n);
    await vault.connect(vaultOwner).requestDeposit(100n, vaultOwner.address, vaultOwner.address);
    await vault.connect(vaultOwner).setPermissionMask(receiver.address, VAULT_SETTLE_MANAGER);
    await settleWithOracle(vault, receiver, 100n);
    await vault.connect(vaultOwner).deposit(0n, vaultOwner.address, vaultOwner.address);

    await vault.connect(vaultOwner).setTransferRestricted(true);
    await vault.connect(vaultOwner).approve(operator.address, 12n);
    expect(await vault.allowance(vaultOwner.address, operator.address)).to.equal(12n);
    await expect(vault.connect(vaultOwner).transfer(receiver.address, 1n)).to.be.revertedWithCustomError(
      vault,
      "TransferDisabled",
    );
    await expect(
      vault.connect(operator).transferFrom(vaultOwner.address, receiver.address, 1n),
    ).to.be.revertedWithCustomError(vault, "TransferDisabled");
    expect(await vault.allowance(vaultOwner.address, operator.address)).to.equal(12n);

    await expect(vault.connect(vaultOwner).requestRedeem(10n, vaultOwner.address, vaultOwner.address)).to.emit(
      vault,
      "RedeemRequest",
    );
    expect(await vault.pendingRedeemRequest(0n, vaultOwner.address)).to.equal(10n);
    await vault.connect(vaultOwner).cancelRedeem(vaultOwner.address);
    expect(await vault.balanceOf(vaultOwner.address)).to.equal(100n);

    await vault.connect(vaultOwner).setTransferRestricted(false);
    await expect(vault.connect(vaultOwner).transfer(receiver.address, 1n)).to.emit(vault, "Transfer");
  });

  it("validates share transfer edge cases and preserves infinite allowance", async function () {
    const { vault, vaultOwner, operator, receiver, asset } = await deployFixture();

    await asset.mint(vaultOwner.address, 100n);
    await asset.connect(vaultOwner).approve(await vault.escrow(), 100n);
    await vault.connect(vaultOwner).requestDeposit(100n, vaultOwner.address, vaultOwner.address);
    await vault.connect(vaultOwner).setPermissionMask(receiver.address, VAULT_SETTLE_MANAGER);
    await settleWithOracle(vault, receiver, 100n);
    await vault.connect(vaultOwner).deposit(0n, vaultOwner.address, vaultOwner.address);

    await expect(vault.connect(vaultOwner).transfer(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
    await expect(vault.connect(receiver).transfer(vaultOwner.address, 1n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await expect(
      vault.connect(operator).transferFrom(vaultOwner.address, receiver.address, 1n),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    await vault.connect(vaultOwner).approve(operator.address, ethers.MaxUint256);
    await expect(vault.connect(operator).transferFrom(vaultOwner.address, receiver.address, 10n))
      .to.emit(vault, "Transfer")
      .withArgs(vaultOwner.address, receiver.address, 10n);
    expect(await vault.allowance(vaultOwner.address, operator.address)).to.equal(ethers.MaxUint256);
    expect(await vault.balanceOf(vaultOwner.address)).to.equal(90n);
    expect(await vault.balanceOf(receiver.address)).to.equal(10n);
  });

  it("lets owners approve and revoke direct operators", async function () {
    const { vault, vaultOwner, operator } = await deployFixture();

    await expect(vault.connect(vaultOwner).setOperator(operator.address, true))
      .to.emit(vault, "OperatorSet")
      .withArgs(vaultOwner.address, operator.address, true);
    expect(await vault.isOperator(vaultOwner.address, operator.address)).to.equal(true);

    await expect(vault.connect(vaultOwner).setOperator(operator.address, false))
      .to.emit(vault, "OperatorSet")
      .withArgs(vaultOwner.address, operator.address, false);
    expect(await vault.isOperator(vaultOwner.address, operator.address)).to.equal(false);
  });

  it("rejects zero direct operator", async function () {
    const { vault, vaultOwner } = await deployFixture();

    await expect(vault.connect(vaultOwner).setOperator(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
  });

  it("approves and revokes operators by EIP-712 signature", async function () {
    const { vault, vaultOwner, operator, outsider } = await deployFixture();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latest?.timestamp ?? 0) + 3600);

    const approveSig = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      0n,
    );
    await expect(
      vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 0n, approveSig),
    )
      .to.emit(vault, "OperatorSet")
      .withArgs(vaultOwner.address, operator.address, true);
    expect(await vault.isOperator(vaultOwner.address, operator.address)).to.equal(true);
    expect(await vault.nonces(vaultOwner.address)).to.equal(1n);

    const revokeSig = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      false,
      deadline,
      1n,
    );
    await vault
      .connect(outsider)
      .setOperatorBySig(vaultOwner.address, operator.address, false, deadline, 1n, revokeSig);
    expect(await vault.isOperator(vaultOwner.address, operator.address)).to.equal(false);
    expect(await vault.nonces(vaultOwner.address)).to.equal(2n);
  });

  it("rejects version 1 operator approvals after the EIP-712 domain upgrade", async function () {
    const { vault, vaultOwner, operator } = await deployFixture();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latest?.timestamp ?? 0) + 3600);
    const staleVersionSignature = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      0n,
      undefined,
      undefined,
      "1",
    );

    await expect(
      vault.setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 0n, staleVersionSignature),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("rejects replayed, expired, wrong signer, wrong domain, and zero-address signatures", async function () {
    const { vault, vaultOwner, operator, outsider, receiver } = await deployFixture();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latest?.timestamp ?? 0) + 3600);
    const signature = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      0n,
    );

    await vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 0n, signature);
    await expect(
      vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 0n, signature),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const expired = BigInt((latest?.timestamp ?? 0) - 1);
    const expiredSig = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      expired,
      1n,
    );
    await expect(
      vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, expired, 1n, expiredSig),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const wrongSignerSig = await signOperatorApproval(
      vault,
      outsider,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      1n,
    );
    await expect(
      vault
        .connect(outsider)
        .setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 1n, wrongSignerSig),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const wrongChainSig = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      1n,
      31338n,
    );
    await expect(
      vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 1n, wrongChainSig),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const wrongVaultSig = await signOperatorApproval(
      vault,
      vaultOwner,
      vaultOwner.address,
      operator.address,
      true,
      deadline,
      1n,
      undefined,
      receiver.address,
    );
    await expect(
      vault.connect(outsider).setOperatorBySig(vaultOwner.address, operator.address, true, deadline, 1n, wrongVaultSig),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    await expect(
      vault
        .connect(outsider)
        .setOperatorBySig(ethers.ZeroAddress, operator.address, true, deadline, 1n, wrongSignerSig),
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    await expect(
      vault
        .connect(outsider)
        .setOperatorBySig(vaultOwner.address, ethers.ZeroAddress, true, deadline, 1n, wrongSignerSig),
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");
  });

  it("lets owner and admins set permission masks without letting admins update owner flags", async function () {
    const { vault, vaultOwner, admin, operator } = await deployFixture();

    expect(await vault.permissionMask(vaultOwner.address)).to.equal(FULL_PERMISSION_MASK);
    expect(await vault.accountHasPermission(vaultOwner.address, OWNER)).to.equal(true);
    expect(await vault.accountHasPermission(vaultOwner.address, ADMIN)).to.equal(true);

    await expect(vault.connect(vaultOwner).setPermissionMask(admin.address, ADMIN))
      .to.emit(vault, "VaultPermissionUpdated")
      .withArgs(admin.address, ADMIN);
    expect(await vault.permissionMask(admin.address)).to.equal(ADMIN);
    expect(await vault.accountHasPermission(admin.address, ADMIN)).to.equal(true);

    await expect(vault.connect(admin).setPermissionMask(operator.address, VAULT_ASSET_MANAGER))
      .to.emit(vault, "VaultPermissionUpdated")
      .withArgs(operator.address, VAULT_ASSET_MANAGER);
    expect(await vault.accountHasPermission(operator.address, OWNER | VAULT_ASSET_MANAGER)).to.equal(false);
    expect(await vault.accountHasAnyPermission(operator.address, OWNER | VAULT_ASSET_MANAGER)).to.equal(true);
    expect(await vault.accountHasAnyPermission(operator.address, OWNER)).to.equal(false);
    expect(await vault.accountHasAnyPermission(operator.address, 0n)).to.equal(false);
    expect(await vault.accountHasPermission(operator.address, VAULT_ASSET_MANAGER)).to.equal(true);

    await expect(vault.connect(admin).setPermissionMask(operator.address, OWNER))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(admin.address);
  });

  it("rejects unauthorized permission updates and zero permission account", async function () {
    const { vault, outsider, vaultOwner } = await deployFixture();

    await expect(vault.connect(outsider).setPermissionMask(outsider.address, ADMIN))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await expect(vault.connect(vaultOwner).setPermissionMask(ethers.ZeroAddress, ADMIN)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
  });

  it("lets config managers configure curator fees before supply exists", async function () {
    const { vault, vaultOwner, admin, receiver } = await deployFixture();
    const managementFee = 20_000_000_000_000_000n;
    const performanceFeePeriod = 30n * 24n * 60n * 60n;
    const performanceFee = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]], performanceFeePeriod);

    await expect(vault.connect(vaultOwner).setFees(managementFee, performanceFee))
      .to.emit(vault, "VaultFeesUpdated")
      .withArgs(managementFee, performanceFee);

    expect(await vault.fees()).to.deep.equal([managementFee, performanceFee]);

    await vault.connect(vaultOwner).setPermissionMask(admin.address, ADMIN);
    await expect(vault.connect(admin).setFees(1n, performanceFee))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(admin.address);

    await vault.connect(vaultOwner).setPermissionMask(receiver.address, (1n << 253n) | VAULT_CONFIG_MANAGER);
    const nextPerformanceFee = packPerformanceFeeSchedule([[2n, MAX_PERFORMANCE_THRESHOLD_BPS]]);
    await expect(vault.connect(receiver).setFees(1n, nextPerformanceFee))
      .to.emit(vault, "VaultFeesUpdated")
      .withArgs(1n, nextPerformanceFee);

    await vault.connect(vaultOwner).setPermissionMask(receiver.address, OWNER);
    await expect(vault.connect(receiver).setFees(3n, nextPerformanceFee))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(receiver.address);
  });

  it("lets config managers configure investment range", async function () {
    const { vault, vaultOwner, outsider, receiver } = await deployFixture();
    const maxUint = (1n << 256n) - 1n;

    expect(await vault.investmentRange()).to.deep.equal([0n, maxUint]);

    await expect(vault.connect(outsider).setInvestmentRange(10n, 1000n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await vault.connect(vaultOwner).setPermissionMask(receiver.address, (1n << 253n) | VAULT_CONFIG_MANAGER);
    await expect(vault.connect(receiver).setInvestmentRange(10n, 1000n))
      .to.emit(vault, "InvestmentRangeUpdated")
      .withArgs(10n, 1000n);

    expect(await vault.investmentRange()).to.deep.equal([10n, 1000n]);

    await expect(vault.connect(receiver).setInvestmentRange(0n, maxUint))
      .to.emit(vault, "InvestmentRangeUpdated")
      .withArgs(0n, maxUint);

    await expect(vault.connect(receiver).setInvestmentRange(0n, 0n))
      .to.emit(vault, "InvestmentRangeUpdated")
      .withArgs(0n, 0n);
  });

  it("rejects unauthorized over-cap and locked curator fee updates", async function () {
    const { vault, vaultOwner, outsider, receiver, asset } = await deployFixture();
    const validPerformanceFee = packPerformanceFeeSchedule([[1n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    await expect(vault.connect(outsider).setFees(1n, validPerformanceFee))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await expect(vault.connect(vaultOwner).setFees(100_000_000_000_000_001n, 0n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await expect(
      vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[5_001n, MAX_PERFORMANCE_THRESHOLD_BPS]])),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[1_000n, 1_000n]])),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(vaultOwner).setFees(
        0n,
        packPerformanceFeeSchedule([
          [1_000n, 2_000n],
          [1_000n, 1_500n],
          [1_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
        ]),
      ),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([], 30n * 24n * 60n * 60n)),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(vault.connect(vaultOwner).setFees(0n, 1n << 160n)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );

    await asset.mint(vaultOwner.address, 100n);
    await asset.connect(vaultOwner).approve(await vault.escrow(), 100n);
    await vault.connect(vaultOwner).requestDeposit(100n, vaultOwner.address, vaultOwner.address);
    await vault.connect(vaultOwner).setPermissionMask(receiver.address, VAULT_SETTLE_MANAGER);
    await settleWithOracle(vault, receiver, 100n);
    await vault.connect(vaultOwner).deposit(0n, vaultOwner.address, vaultOwner.address);

    expect(await vault.totalSupply()).to.equal(100n);

    await expect(vault.connect(vaultOwner).setFees(1n, validPerformanceFee)).to.be.revertedWithCustomError(
      vault,
      "FeeConfigLocked",
    );
  });
});
