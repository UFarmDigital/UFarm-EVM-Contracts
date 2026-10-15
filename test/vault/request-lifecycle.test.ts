import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const CORE_FINANCE_MANAGER = 1n << 5n;
const CURATOR_FINANCE_MANAGER = 1n << 1n;
const VAULT_ASSET_MANAGER = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const VAULT_CONFIG_MANAGER = 1n << 2n;
const VAULT_CUSTOMER_MANAGER = 1n << 3n;
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;

async function deployFixture() {
  const [
    authority,
    registrar,
    curatorOwner,
    vaultOwner,
    owner,
    operator,
    assetManager,
    outsider,
    receiver,
    customerManager,
  ] = await ethers.getSigners();
  const name = "UFarm Request Vault";
  const symbol = "uREQ";

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());

  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const customAsset = await ethers.deployContract("MockERC20", ["Euro Coin", "EUROC", 18]);

  await core.setPermissionMask(registrar.address, (1n << 253n) | 1n);
  const assetFeed = await configureValueToken(ethers, core, asset, { maxAge: 10n * BigInt(YEAR) });
  const customAssetFeed = await configureValueToken(ethers, core, customAsset, { maxAge: 10n * BigInt(YEAR) });

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("request-curator"));
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
    .createVault(ethers.id("request-vault"), vaultOwner.address, name, symbol, await asset.getAddress());
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

  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(customerManager.address, VAULT_CUSTOMER_MANAGER);
  await vault.connect(owner).setOperator(operator.address, true);
  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);
  await customAsset.mint(owner.address, 1_000_000n);
  await customAsset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);

  return {
    authority,
    core,
    curator,
    escrow,
    vault,
    oracle,
    asset,
    assetFeed,
    customAsset,
    customAssetFeed,
    curatorOwner,
    vaultOwner,
    owner,
    operator,
    assetManager,
    outsider,
    receiver,
    customerManager,
  };
}

async function seedShares(fixture: Awaited<ReturnType<typeof deployFixture>>, holder: any, amount: bigint) {
  const { vault, asset, assetManager } = fixture;
  await asset.mint(holder.address, amount);
  await asset.connect(holder).approve(await vault.escrow(), amount);
  const nav = await vault.totalSupply();
  await vault.connect(holder).requestDeposit(amount, holder.address, holder.address);
  await settleWithOracle(vault, assetManager, nav);
  await vault.connect(holder).deposit(0n, holder.address, holder.address);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function advancePastSettlementCooldown(vault: any) {
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
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
  await advancePastSettlementCooldown(vault);
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  return oracle.submitNav(requestId, nav, await nextBlockTimestamp());
}

async function makeClientVerification(
  vault: any,
  signer: any,
  client: string,
  tier: bigint | number,
  validTill: bigint,
  versionOverride = "2",
) {
  const network = await ethers.provider.getNetwork();
  const vaultAddress = await vault.getAddress();
  const signature = await signer.signTypedData(
    {
      name: "UFarmVault",
      version: versionOverride,
      chainId: network.chainId,
      verifyingContract: vaultAddress,
    },
    {
      ClientVerification: [
        { name: "client", type: "address" },
        { name: "vault", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "validTill", type: "uint64" },
      ],
    },
    { client, vault: vaultAddress, tier, validTill },
  );

  return { signature, validTill, tier };
}

type SignedRequestKind = "deposit" | "redeem";

function signedRequestTypes(kind: SignedRequestKind) {
  const primaryType = kind === "deposit" ? "SignedDepositRequest" : "SignedRedeemRequest";
  return {
    [primaryType]: [
      { name: "request", type: "RequestParams" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    RequestParams: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minOutputAmount", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
  };
}

type SignedRequestInput = {
  asset: string;
  amount: bigint;
  minOutputAmount?: bigint;
  controller: string;
  owner: string;
  nonce: bigint;
  deadline: bigint;
};

async function makeSignedRequest(
  kind: SignedRequestKind,
  vault: any,
  signer: any,
  request: SignedRequestInput,
  versionOverride = "2",
) {
  const network = await ethers.provider.getNetwork();
  const requestParams = {
    asset: request.asset,
    amount: request.amount,
    minOutputAmount: request.minOutputAmount ?? 0n,
    controller: request.controller,
    owner: request.owner,
  };
  const domain = {
    name: "UFarmVault",
    version: versionOverride,
    chainId: network.chainId,
    verifyingContract: await vault.getAddress(),
  };
  const value = { request: requestParams, nonce: request.nonce, deadline: request.deadline };
  const signature = await signer.signTypedData(domain, signedRequestTypes(kind), value);

  return { request: requestParams, nonce: request.nonce, deadline: request.deadline, signature };
}

function signedRequestDigest(
  kind: SignedRequestKind,
  vaultAddress: string,
  chainId: bigint,
  request: SignedRequestInput,
) {
  const domain = { name: "UFarmVault", version: "2", chainId, verifyingContract: vaultAddress };
  const value = {
    request: {
      asset: request.asset,
      amount: request.amount,
      minOutputAmount: request.minOutputAmount ?? 0n,
      controller: request.controller,
      owner: request.owner,
    },
    nonce: request.nonce,
    deadline: request.deadline,
  };
  return ethers.TypedDataEncoder.hash(domain, signedRequestTypes(kind), value);
}

const YEAR = 365 * 24 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;
const MONTH = 30 * 24 * 60 * 60;
const WAD = 10n ** 18n;
const SIGNED_SETTLE_SELECTOR =
  "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])";
const RequestState = { AlreadyActive: 1n, NoPending: 2n, NoClaimable: 3n, NoBatch: 4n, QueueFull: 5n };
const OracleFlow = {
  Invalid: 1n,
  InvalidRequest: 2n,
  Active: 3n,
  NoneActive: 4n,
  NotTimedOut: 5n,
  Cooldown: 6n,
  InvalidValuationTime: 7n,
};

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>, period = 0n) {
  const schedule = steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
  return schedule | (period << 128n);
}

async function expectPerformancePeriodCooldown(vault: any, signer: any) {
  let revertedWithCooldown = false;
  try {
    await ethers.provider.call({
      to: await vault.getAddress(),
      from: signer.address,
      data: vault.interface.encodeFunctionData("settleRequests()"),
    });
  } catch (error) {
    revertedWithCooldown = String(error).includes("OracleFlowError(6)");
  }
  expect(revertedWithCooldown).to.equal(true);
}

describe("UFarmVault request lifecycle", function () {
  it("rejects version 1 signed settlement requests without consuming the nonce", async function () {
    const { vault, asset, owner, assetManager, vaultOwner } = await deployFixture();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const staleVersionRequest = await makeSignedRequest(
      "deposit",
      vault,
      owner,
      {
        asset: await asset.getAddress(),
        amount: 100n,
        minOutputAmount: 0n,
        controller: owner.address,
        owner: owner.address,
        nonce: 0n,
        deadline,
      },
      "1",
    );
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const signedSettleRequests = vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR);

    await expect(signedSettleRequests([staleVersionRequest], []))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(0n);
  });

  it("stores signed batch deposits, skips invalid requests, and starts oracle settlement", async function () {
    const { core, vault, oracle, asset, owner, receiver, assetManager, vaultOwner } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());

    const validDeposit = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 100n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    const invalidDeposit = {
      ...(await makeSignedRequest("deposit", vault, owner, {
        asset: await asset.getAddress(),
        amount: 50n,
        controller: receiver.address,
        owner: receiver.address,
        nonce: 0n,
        deadline,
      })),
      request: {
        asset: await asset.getAddress(),
        amount: 50n,
        minOutputAmount: 0n,
        controller: receiver.address,
        owner: receiver.address,
      },
    };
    const signedSettleRequests = vault
      .connect(assetManager)
      .getFunction(
        SIGNED_SETTLE_SELECTOR,
      );

    await expect(signedSettleRequests([validDeposit, invalidDeposit], []))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(assetManager.address);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(signedSettleRequests([validDeposit, invalidDeposit], [])).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.pendingDepositRequest(0n, receiver.address)).to.equal(0n);
    expect(await vault.activeOracleRequestId()).to.not.equal(0n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.requestNonces(receiver.address)).to.equal(0n);
  });

  it("does not accept a signed deposit request as a redeem", async function () {
    const fixture = await deployFixture();
    const { vault, asset, owner, assetManager, vaultOwner } = fixture;
    await seedShares(fixture, owner, 100n);
    await advancePastSettlementCooldown(vault);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const request = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 40n,
      minOutputAmount: 0n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await expect(vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([], [request]))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
  });

  it("does not accept a signed redeem request as a deposit", async function () {
    const { vault, asset, owner, assetManager, vaultOwner } = await deployFixture();
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const balanceBefore = await asset.balanceOf(owner.address);
    const request = await makeSignedRequest("redeem", vault, owner, {
      asset: await asset.getAddress(),
      amount: 40n,
      minOutputAmount: 0n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await expect(vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([request], []))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(0n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await asset.balanceOf(owner.address)).to.equal(balanceBefore);
  });

  it("accepts ERC-1271 signatures for signed batch deposits", async function () {
    const { core, vault, oracle, asset, assetManager, vaultOwner } = await deployFixture();
    const wallet = await ethers.deployContract("MockERC1271RequestOwner");
    const walletAddress = await wallet.getAddress();
    const assetAddress = await asset.getAddress();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await asset.mint(walletAddress, 1_000n);
    await wallet.approveToken(assetAddress, await vault.escrow(), 1_000n);

    const request = {
      asset: assetAddress,
      amount: 100n,
      minOutputAmount: 0n,
      controller: walletAddress,
      owner: walletAddress,
      nonce: 0n,
      deadline,
    };
    const digest = signedRequestDigest("deposit", vaultAddress, chainId, request);
    await wallet.setValidDigest(digest, true);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([{ request, nonce: request.nonce, deadline, signature: "0x01" }], []),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingDepositRequest(0n, walletAddress)).to.equal(100n);
    expect(await vault.requestNonces(walletAddress)).to.equal(1n);
  });

  it("bounds ERC-1271 validation gas and continues the signed batch", async function () {
    const { core, vault, oracle, asset, owner, assetManager, vaultOwner } = await deployFixture();
    const gasBomb = await ethers.deployContract("MockERC1271RequestOwner");
    const gasBombAddress = await gasBomb.getAddress();
    const assetAddress = await asset.getAddress();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await gasBomb.setConsumeAllGas(true);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    const maliciousRequest = {
      request: {
        asset: assetAddress,
        amount: 100n,
        minOutputAmount: 0n,
        controller: gasBombAddress,
        owner: gasBombAddress,
      },
      nonce: 0n,
      deadline,
      signature: "0x01",
    };
    const validRequest = await makeSignedRequest("deposit", vault, owner, {
      asset: assetAddress,
      amount: 100n,
      minOutputAmount: 0n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });

    await expect(
      vault
        .connect(assetManager)
        .getFunction(SIGNED_SETTLE_SELECTOR)([maliciousRequest, validRequest], [], { gasLimit: 1_500_000n }),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingDepositRequest(0n, gasBombAddress)).to.equal(0n);
    expect(await vault.requestNonces(gasBombAddress)).to.equal(0n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
  });

  it("stores signed batch redeems, requires a whitelisted redeem asset, and starts oracle settlement", async function () {
    const { core, vault, oracle, asset, owner, receiver, outsider, assetManager, vaultOwner } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const unsupportedAsset = await ethers.deployContract("MockERC20", ["Unsupported", "BAD", 18]);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await seedShares({ core, vault, oracle, asset, assetManager } as any, owner, 100n);
    await seedShares({ core, vault, oracle, asset, assetManager } as any, receiver, 75n);
    await seedShares({ core, vault, oracle, asset, assetManager } as any, outsider, 50n);
    await advancePastSettlementCooldown(vault);

    const validRedeem = await makeSignedRequest("redeem", vault, owner, {
      asset: await asset.getAddress(),
      amount: 40n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    const zeroAssetRedeem = await makeSignedRequest("redeem", vault, receiver, {
      asset: ethers.ZeroAddress,
      amount: 25n,
      controller: receiver.address,
      owner: receiver.address,
      nonce: 0n,
      deadline,
    });
    const unsupportedAssetRedeem = await makeSignedRequest("redeem", vault, outsider, {
      asset: await unsupportedAsset.getAddress(),
      amount: 15n,
      controller: outsider.address,
      owner: outsider.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([], [validRedeem, zeroAssetRedeem, unsupportedAssetRedeem]),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.pendingRedeemRequest(0n, receiver.address)).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, outsider.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(60n);
    expect(await vault.balanceOf(receiver.address)).to.equal(75n);
    expect(await vault.balanceOf(outsider.address)).to.equal(50n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.requestNonces(receiver.address)).to.equal(0n);
    expect(await vault.requestNonces(outsider.address)).to.equal(0n);
  });

  it("accepts ERC-1271 signatures for signed batch redeems", async function () {
    const { core, vault, oracle, asset, owner, assetManager, vaultOwner } = await deployFixture();
    const wallet = await ethers.deployContract("MockERC1271RequestOwner");
    const walletAddress = await wallet.getAddress();
    const assetAddress = await asset.getAddress();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await seedShares({ core, vault, oracle, asset, assetManager } as any, owner, 100n);
    await vault.connect(owner).transfer(walletAddress, 60n);
    await advancePastSettlementCooldown(vault);

    const request = {
      asset: assetAddress,
      amount: 40n,
      minOutputAmount: 0n,
      controller: walletAddress,
      owner: walletAddress,
      nonce: 0n,
      deadline,
    };
    const digest = signedRequestDigest("redeem", vaultAddress, chainId, request);
    await wallet.setValidDigest(digest, true);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([], [{ request, nonce: request.nonce, deadline, signature: "0x01" }]),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingRedeemRequest(0n, walletAddress)).to.equal(40n);
    expect(await vault.balanceOf(walletAddress)).to.equal(20n);
    expect(await vault.requestNonces(walletAddress)).to.equal(1n);
  });

  it("settles and claims signed redeems in the requested value token", async function () {
    const { core, vault, oracle, asset, customAsset, escrow, owner, assetManager, vaultOwner } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const customAssetAddress = await customAsset.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await seedShares({ core, vault, oracle, asset, assetManager } as any, owner, 100n);
    await customAsset.mint(vaultAddress, 100n);
    await advancePastSettlementCooldown(vault);

    const validRedeem = await makeSignedRequest("redeem", vault, owner, {
      asset: customAssetAddress,
      amount: 40n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await vault
      .connect(assetManager)
      .getFunction(
        SIGNED_SETTLE_SELECTOR,
      )([], [validRedeem]);

    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 100n, await nextBlockTimestamp()))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, customAssetAddress, 40n, 40n);
    expect(await escrow.balanceOf(vaultAddress, customAssetAddress, owner.address)).to.deep.equal([40n, 0n]);

    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, customAssetAddress, 40n);
    expect(await customAsset.balanceOf(owner.address)).to.equal(1_000_040n);
  });

  it("settles a signed deposit when shares equal its minimum output", async function () {
    const { core, vault, oracle, asset, owner, assetManager, vaultOwner } = await deployFixture();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const request = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 100n,
      minOutputAmount: 100n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([request], []);
    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 0n, await nextBlockTimestamp()))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, await asset.getAddress(), 100n, 100n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
  });

  it("fails and unlocks a signed deposit below its minimum output without blocking the batch", async function () {
    const { core, escrow, vault, oracle, asset, owner, receiver, assetManager, vaultOwner } = await deployFixture();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await asset.mint(receiver.address, 50n);
    await asset.connect(receiver).approve(await escrow.getAddress(), 50n);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const ownerRequest = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 100n,
      minOutputAmount: 101n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    const receiverRequest = await makeSignedRequest("deposit", vault, receiver, {
      asset: await asset.getAddress(),
      amount: 50n,
      minOutputAmount: 0n,
      controller: receiver.address,
      owner: receiver.address,
      nonce: 0n,
      deadline,
    });
    await vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([ownerRequest, receiverRequest], []);
    const tx = oracle.submitNav(await vault.activeOracleRequestId(), 0n, await nextBlockTimestamp());
    await expect(tx).to.emit(vault, "RequestFailed").withArgs(owner.address, 1n, 4n);
    await expect(tx)
      .to.emit(vault, "DepositSettled")
      .withArgs(receiver.address, await asset.getAddress(), 50n, 50n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.requestNonces(receiver.address)).to.equal(1n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      100n,
      0n,
    ]);
  });

  it("settles a signed redeem when assets equal its minimum output", async function () {
    const fixture = await deployFixture();
    const { core, vault, asset, owner, assetManager, vaultOwner } = fixture;
    await seedShares(fixture, owner, 100n);
    await advancePastSettlementCooldown(vault);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const request = await makeSignedRequest("redeem", vault, owner, {
      asset: await asset.getAddress(),
      amount: 40n,
      minOutputAmount: 40n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([], [request]);
    const oracle = await ethers.getContractAt("MockUFarmOracle", await core.oracleForVault(await vault.getAddress()));
    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 100n, await nextBlockTimestamp()))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, await asset.getAddress(), 40n, 40n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
  });

  it("fails and returns shares for a signed redeem below its minimum output", async function () {
    const fixture = await deployFixture();
    const { core, vault, asset, owner, assetManager, vaultOwner } = fixture;
    await seedShares(fixture, owner, 100n);
    await advancePastSettlementCooldown(vault);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const request = await makeSignedRequest("redeem", vault, owner, {
      asset: await asset.getAddress(),
      amount: 40n,
      minOutputAmount: 41n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault.connect(assetManager).getFunction(SIGNED_SETTLE_SELECTOR)([], [request]);
    const oracle = await ethers.getContractAt("MockUFarmOracle", await core.oracleForVault(await vault.getAddress()));
    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 100n, await nextBlockTimestamp()))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 2n, 4n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("records deposit requests and moves assets into escrow with a one week lock", async function () {
    const { escrow, vault, asset, owner } = await deployFixture();

    const tx = await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(tx).to.emit(vault, "DepositRequest").withArgs(owner.address, owner.address, 0n, owner.address, 100n);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);

    expect(await asset.balanceOf(owner.address)).to.equal(999_900n);
    expect(await asset.balanceOf(await escrow.getAddress())).to.equal(100n);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      100n,
      BigInt(block!.timestamp + WEEK),
    ]);
  });

  it("records custom asset deposit requests and settles using the requested asset", async function () {
    const { escrow, vault, customAsset, owner, assetManager } = await deployFixture();

    await expect(
      vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
        await customAsset.getAddress(),
        75n,
        owner.address,
        owner.address,
        { signature: "0x", validTill: 0n, tier: 0n },
      ),
    )
      .to.emit(vault, "DepositRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 75n);

    expect(await customAsset.balanceOf(owner.address)).to.equal(999_925n);
    expect(await customAsset.balanceOf(await escrow.getAddress())).to.equal(75n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(75n);

    await expect(settleWithOracle(vault, assetManager, 75n))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, await customAsset.getAddress(), 75n, 75n);

    expect(
      await escrow.balanceOf(await vault.getAddress(), await customAsset.getAddress(), owner.address),
    ).to.deep.equal([0n, 0n]);
    expect(await customAsset.balanceOf(await vault.getAddress())).to.equal(75n);
  });

  it("mints shares from the deposit token USD value", async function () {
    const { core, escrow, vault, owner, assetManager } = await deployFixture();
    const pricedAsset = await ethers.deployContract("MockERC20", ["Priced USD", "pUSD", 6]);
    const pricedAssetAddress = await pricedAsset.getAddress();
    const depositAssets = 100n * 10n ** 6n;

    await configureValueToken(ethers, core, pricedAsset, { answer: 99_000_000n });
    await pricedAsset.mint(owner.address, depositAssets);
    await pricedAsset.connect(owner).approve(await escrow.getAddress(), depositAssets);
    await vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
      pricedAssetAddress,
      depositAssets,
      owner.address,
      owner.address,
      { signature: "0x", validTill: 0n, tier: 0n },
    );

    await expect(settleWithOracle(vault, assetManager, 0n))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, pricedAssetAddress, depositAssets, 99n * WAD);
    expect(await vault.totalSupply()).to.equal(99n * WAD);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(99n * WAD);
  });

  it("converts redeem USD entitlement into payout token units", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, owner, assetManager, vaultOwner } = fixture;
    const vaultAddress = await vault.getAddress();
    const payoutAsset = await ethers.deployContract("MockERC20", ["Priced USD", "pUSD", 6]);
    const payoutAssetAddress = await payoutAsset.getAddress();

    await core.setNavRequestCooldown(1n);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await configureValueToken(ethers, core, payoutAsset, { answer: 99_000_000n });
    await seedShares(fixture, owner, 100n * WAD);
    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);
    await payoutAsset.mint(vaultAddress, 100n * 10n ** 6n);

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const signedRedeem = await makeSignedRequest("redeem", vault, owner, {
      asset: payoutAssetAddress,
      amount: 50n * WAD,
      controller: owner.address,
      owner: owner.address,
      nonce: await vault.requestNonces(owner.address),
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    await vault
      .connect(assetManager)
      .getFunction(
        SIGNED_SETTLE_SELECTOR,
      )([], [signedRedeem]);

    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 100n * WAD, await nextBlockTimestamp()))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, payoutAssetAddress, 50n * WAD, 50_505_050n);
  });

  it("uses prices above one dollar without assuming a peg", async function () {
    const { core, escrow, vault, oracle, owner, assetManager, vaultOwner } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const pricedAsset = await ethers.deployContract("MockERC20", ["Priced USD", "pUSD", 6]);
    const pricedAssetAddress = await pricedAsset.getAddress();
    const depositAssets = 100n * 10n ** 6n;

    await core.setNavRequestCooldown(1n);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await configureValueToken(ethers, core, pricedAsset, { answer: 101_000_000n });
    await pricedAsset.mint(owner.address, depositAssets);
    await pricedAsset.connect(owner).approve(await escrow.getAddress(), depositAssets);
    await vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
      pricedAssetAddress,
      depositAssets,
      owner.address,
      owner.address,
      { signature: "0x", validTill: 0n, tier: 0n },
    );

    await expect(settleWithOracle(vault, assetManager, 0n))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, pricedAssetAddress, depositAssets, 101n * WAD);
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const signedRedeem = await makeSignedRequest("redeem", vault, owner, {
      asset: pricedAssetAddress,
      amount: 50n * WAD,
      controller: owner.address,
      owner: owner.address,
      nonce: await vault.requestNonces(owner.address),
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    await vault
      .connect(assetManager)
      .getFunction(
        SIGNED_SETTLE_SELECTOR,
      )([], [signedRedeem]);

    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 101n * WAD, await nextBlockTimestamp()))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, pricedAssetAddress, 50n * WAD, 49_504_950n);
  });

  it("enforces investment range only for public deposit requests", async function () {
    const { core, vault, oracle, asset, customAsset, escrow, owner, receiver, assetManager, vaultOwner } =
      await deployFixture();
    const vaultAddress = await vault.getAddress();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await vault.connect(vaultOwner).setInvestmentRange(50n, 150n);

    await expect(vault.connect(owner).requestDeposit(49n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await expect(vault.connect(owner).requestDeposit(151n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await expect(
      vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
        await customAsset.getAddress(),
        49n,
        owner.address,
        owner.address,
        { signature: "0x", validTill: 0n, tier: 0n },
      ),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    await expect(vault.connect(owner).requestDeposit(50n, owner.address, owner.address))
      .to.emit(vault, "DepositRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 50n);

    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await escrow.getAddress(), 100n);
    const signedDeposit = await makeSignedRequest("deposit", vault, receiver, {
      asset: await asset.getAddress(),
      amount: 10n,
      controller: receiver.address,
      owner: receiver.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([signedDeposit], []),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingDepositRequest(0n, receiver.address)).to.equal(10n);
  });

  it("checks public deposit investment range against USD value", async function () {
    const { core, vault, escrow, owner, vaultOwner } = await deployFixture();
    const sixDecimalAsset = await ethers.deployContract("MockERC20", ["Six Decimal USD", "USDX", 6]);
    await configureValueToken(ethers, core, sixDecimalAsset);
    const sixDecimalAssetAddress = await sixDecimalAsset.getAddress();
    const requestCustomDeposit = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");

    await vault.connect(vaultOwner).setInvestmentRange(50n * WAD, 150n * WAD);
    await sixDecimalAsset.mint(owner.address, 100_000_000n);
    await sixDecimalAsset.connect(owner).approve(await escrow.getAddress(), 100_000_000n);

    await expect(
      requestCustomDeposit(sixDecimalAssetAddress, 49_000_000n, owner.address, owner.address, {
        signature: "0x",
        validTill: 0n,
        tier: 0n,
      }),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    await expect(
      requestCustomDeposit(sixDecimalAssetAddress, 50_000_000n, owner.address, owner.address, {
        signature: "0x",
        validTill: 0n,
        tier: 0n,
      }),
    )
      .to.emit(vault, "DepositRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 50_000_000n);
  });

  it("requires customer manager verification for custom deposits when client tier is enabled", async function () {
    const { vault, customAsset, owner, outsider, customerManager, vaultOwner } = await deployFixture();
    const customRequest = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");

    await expect(vault.connect(outsider).setClientTier(2n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await vault.connect(vaultOwner).setPermissionMask(outsider.address, (1n << 253n) | VAULT_CONFIG_MANAGER);
    await vault.connect(outsider).setClientTier(2n);
    expect(await vault.clientTier()).to.equal(2n);

    await expect(
      customRequest(await customAsset.getAddress(), 75n, owner.address, owner.address, {
        signature: "0x",
        validTill: (await nextBlockTimestamp()) + 3600n,
        tier: 0n,
      }),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const validTill = (await nextBlockTimestamp()) + 3600n;
    const lowTierVerification = await makeClientVerification(vault, customerManager, owner.address, 1n, validTill);
    await expect(
      customRequest(await customAsset.getAddress(), 75n, owner.address, owner.address, lowTierVerification),
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    const validVerification = await makeClientVerification(vault, customerManager, owner.address, 2n, validTill);
    await expect(customRequest(await customAsset.getAddress(), 75n, owner.address, owner.address, validVerification))
      .to.emit(vault, "DepositRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 75n);
  });

  it("rejects version 1 client verification signatures", async function () {
    const { vault, customAsset, owner, customerManager, vaultOwner } = await deployFixture();
    const customRequest = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");
    await vault.connect(vaultOwner).setClientTier(2n);
    const validTill = (await nextBlockTimestamp()) + 3600n;
    const staleVerification = await makeClientVerification(
      vault,
      customerManager,
      owner.address,
      2n,
      validTill,
      "1",
    );

    await expect(
      customRequest(await customAsset.getAddress(), 75n, owner.address, owner.address, staleVerification),
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
  });

  it("allows approved operators to request deposits and rejects invalid deposit callers and inputs", async function () {
    const { vault, asset, owner, operator, outsider, receiver } = await deployFixture();
    const unsupportedAsset = await ethers.deployContract("MockERC20", ["Unsupported", "BAD", 18]);

    await expect(
      vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
        await unsupportedAsset.getAddress(),
        10n,
        owner.address,
        owner.address,
        { signature: "0x", validTill: 0n, tier: 0n },
      ),
    )
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);

    await expect(vault.connect(operator).requestDeposit(10n, owner.address, owner.address)).to.emit(
      vault,
      "DepositRequest",
    );

    await expect(vault.connect(outsider).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(owner).requestDeposit(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    await expect(vault.connect(owner).requestDeposit(10n, receiver.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("rejects deposit requests when the asset feed is stale", async function () {
    const { core, vault, asset, owner } = await deployFixture();
    const assetFeed = await configureValueToken(ethers, core, asset, { maxAge: 3_600n });
    const latest = await ethers.provider.getBlock("latest");
    await assetFeed.setRoundData(100_000_000n, BigInt(latest!.timestamp) - 3_601n);

    await expect(vault.connect(owner).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("rejects deposit requests when the asset feed reverts", async function () {
    const { vault, assetFeed, owner } = await deployFixture();
    await assetFeed.setShouldRevert(true);

    await expect(vault.connect(owner).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("rejects deposit requests when the asset price is out of bounds", async function () {
    const { vault, assetFeed, owner } = await deployFixture();
    await assetFeed.setRoundData(89_000_000n, await nextBlockTimestamp());

    await expect(vault.connect(owner).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("skips signed redeems with unconfigured or invalid payout asset feeds", async function () {
    const fixture = await deployFixture();
    const {
      core,
      vault,
      oracle,
      asset,
      owner,
      receiver,
      outsider,
      operator,
      customerManager,
      assetManager,
      vaultOwner,
    } = fixture;
    const vaultAddress = await vault.getAddress();
    const holders = [owner, receiver, outsider, operator, customerManager];
    const unconfiguredAsset = await ethers.deployContract("MockERC20", ["Unconfigured", "NONE", 18]);
    const staleAsset = await ethers.deployContract("MockERC20", ["Stale", "STALE", 18]);
    const revertingAsset = await ethers.deployContract("MockERC20", ["Reverting", "REVERT", 18]);
    const outOfBandAsset = await ethers.deployContract("MockERC20", ["Out of Band", "OOB", 18]);
    const staleFeed = await configureValueToken(ethers, core, staleAsset);
    const revertingFeed = await configureValueToken(ethers, core, revertingAsset);
    const outOfBandFeed = await configureValueToken(ethers, core, outOfBandAsset);

    await core.setNavRequestCooldown(1n);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    for (const holder of holders) {
      await seedShares(fixture, holder, 20n);
    }
    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);

    const latest = await ethers.provider.getBlock("latest");
    await staleFeed.setRoundData(100_000_000n, BigInt(latest!.timestamp) - 86_401n);
    await revertingFeed.setShouldRevert(true);
    await outOfBandFeed.setRoundData(111_000_000n, await nextBlockTimestamp());

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const payoutAssets = [
      await asset.getAddress(),
      await unconfiguredAsset.getAddress(),
      await staleAsset.getAddress(),
      await revertingAsset.getAddress(),
      await outOfBandAsset.getAddress(),
    ];
    const signedRedeems = await Promise.all(
      holders.map((holder, index) =>
        makeSignedRequest("redeem", vault, holder, {
          asset: payoutAssets[index],
          amount: 10n,
          controller: holder.address,
          owner: holder.address,
          nonce: 0n,
          deadline,
        }),
      ),
    );
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);

    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([], signedRedeems),
    ).to.emit(vault, "OracleRequestStarted");

    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(10n);
    for (const holder of holders.slice(1)) {
      expect(await vault.pendingRedeemRequest(0n, holder.address)).to.equal(0n);
      expect(await vault.balanceOf(holder.address)).to.equal(20n);
      expect(await vault.requestNonces(holder.address)).to.equal(0n);
    }
  });

  it("prevents new default-asset deposits after its config is cleared", async function () {
    const { core, vault, asset, owner } = await deployFixture();

    await core.clearValueTokenConfig(await asset.getAddress());
    await expect(vault.connect(owner).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("reverts deposit request when global flow is paused", async function () {
    const { core, vault, owner, authority } = await deployFixture();

    await core.connect(authority).setGlobalPauseMask(1n);

    await expect(vault.connect(owner).requestDeposit(100n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("caps pending deposit queue at ten owners", async function () {
    const { vault, asset, escrow } = await deployFixture();
    const holders = (await ethers.getSigners()).slice(9, 20);

    for (const holder of holders) {
      await asset.mint(holder.address, 100n);
      await asset.connect(holder).approve(await escrow.getAddress(), 100n);
    }

    for (const holder of holders.slice(0, 10)) {
      await vault.connect(holder).requestDeposit(10n, holder.address, holder.address);
    }

    await expect(vault.connect(holders[10]).requestDeposit(10n, holders[10].address, holders[10].address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("rejects deposit cancellation by settle manager", async function () {
    const { vault, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(assetManager).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(assetManager.address);
  });

  it("cancels pending deposits by owner and releases escrowed assets", async function () {
    const { escrow, vault, asset, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.emit(vault, "DepositCancelled")
      .withArgs(owner.address, await asset.getAddress(), 100n);

    expect(await asset.balanceOf(owner.address)).to.equal(1_000_000n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("cancels pending deposits by approved operator and releases escrowed assets", async function () {
    const { escrow, vault, asset, owner, operator } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(operator).cancelDeposit(owner.address))
      .to.emit(vault, "DepositCancelled")
      .withArgs(owner.address, await asset.getAddress(), 100n);

    expect(await asset.balanceOf(owner.address)).to.equal(1_000_000n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("clears a pending deposit cancellation after escrow was withdrawn directly", async function () {
    const { escrow, vault, asset, owner, receiver } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const assetAddress = await asset.getAddress();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await increaseTime(WEEK + 1);
    await escrow.connect(owner).withdraw(vaultAddress, assetAddress, 100n, receiver.address);

    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.emit(vault, "DepositCancelled")
      .withArgs(owner.address, assetAddress, 100n);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(vaultAddress, assetAddress, owner.address)).to.deep.equal([0n, 0n]);
  });

  it("clears and unlocks a pending deposit cancellation when escrow token transfer fails", async function () {
    const { escrow, vault, asset, owner } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const assetAddress = await asset.getAddress();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await asset.setTransferReverts(true);

    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.emit(vault, "DepositCancelled")
      .withArgs(owner.address, assetAddress, 100n);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(vaultAddress, assetAddress, owner.address)).to.deep.equal([100n, 0n]);
  });

  it("rejects cancellation by outsider for another owner's pending deposit", async function () {
    const { vault, owner, outsider } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(outsider).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("reverts deposit cancellation when curator flow is paused", async function () {
    const { core, curator, vault, owner, authority } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);

    await expect(vault.connect(owner).cancelDeposit(owner.address)).to.be.revertedWithCustomError(vault, "FlowPaused");
  });

  it("rejects cancellation when no pending deposit exists", async function () {
    const { vault, owner } = await deployFixture();

    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoPending);
  });

  it("removes a cancelled pending deposit by linear queue lookup without affecting other owners", async function () {
    const { vault, asset, owner, receiver, assetManager } = await deployFixture();

    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);
    await vault.connect(owner).cancelDeposit(owner.address);
    await settleWithOracle(vault, assetManager, 50n);

    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    await expect(settleWithOracle(vault, assetManager, 50n)).to.emit(vault, "OracleNAVReceived");
  });

  it("settles pending deposits in request order while clearing the queue once", async function () {
    const { vault, asset, owner, receiver, assetManager } = await deployFixture();

    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);

    await expect(settleWithOracle(vault, assetManager, 150n))
      .to.emit(vault, "DepositSettled")
      .withArgs(owner.address, await asset.getAddress(), 100n, 100n)
      .and.to.emit(vault, "DepositSettled")
      .withArgs(receiver.address, await asset.getAddress(), 50n, 50n);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    await expect(settleWithOracle(vault, assetManager, 150n)).to.emit(vault, "OracleNAVReceived");
  });

  it("does not let one failed deposit escrow transfer block the rest of the batch", async function () {
    const { escrow, vault, asset, customAsset, owner, receiver, assetManager } = await deployFixture();

    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);

    await vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
      await customAsset.getAddress(),
      100n,
      owner.address,
      owner.address,
      { signature: "0x", validTill: 0n, tier: 0n },
    );
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);

    await customAsset.setTransferReverts(true);

    await expect(settleWithOracle(vault, assetManager, 150n))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 1n, 3n)
      .and.to.emit(vault, "DepositSettled")
      .withArgs(receiver.address, await asset.getAddress(), 50n, 50n);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    expect(
      await escrow.balanceOf(await vault.getAddress(), await customAsset.getAddress(), owner.address),
    ).to.deep.equal([100n, 0n]);
  });

  it("isolates a deposit whose feed becomes invalid before the oracle callback", async function () {
    const { core, escrow, vault, oracle, asset, customAsset, customAssetFeed, owner, receiver, assetManager } =
      await deployFixture();
    const vaultAddress = await vault.getAddress();
    const customAssetAddress = await customAsset.getAddress();

    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await asset.mint(receiver.address, 50n);
    await asset.connect(receiver).approve(await escrow.getAddress(), 50n);
    await vault.connect(owner).getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))")(
      customAssetAddress,
      100n,
      owner.address,
      owner.address,
      { signature: "0x", validTill: 0n, tier: 0n },
    );
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);

    await vault.connect(assetManager).getFunction("settleRequests()")();
    const requestId = await vault.activeOracleRequestId();
    await customAssetFeed.setShouldRevert(true);

    await expect(oracle.submitNav(requestId, 150n, await nextBlockTimestamp()))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 1n, 1n)
      .and.to.emit(vault, "DepositSettled")
      .withArgs(receiver.address, await asset.getAddress(), 50n, 50n);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    expect(await escrow.balanceOf(vaultAddress, customAssetAddress, owner.address)).to.deep.equal([100n, 0n]);
  });

  it("does not mint shares for an expired deposit withdrawn from escrow before settlement", async function () {
    const { escrow, vault, asset, owner, receiver, assetManager } = await deployFixture();

    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);

    await increaseTime(WEEK + 1);

    const receiverBalanceBeforeWithdraw = await asset.balanceOf(receiver.address);
    await expect(
      escrow.connect(owner).withdraw(await vault.getAddress(), await asset.getAddress(), 100n, receiver.address),
    )
      .to.emit(escrow, "EscrowWithdrawn")
      .withArgs(await vault.getAddress(), await asset.getAddress(), owner.address, receiver.address, 100n);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBeforeWithdraw + 100n);

    await expect(settleWithOracle(vault, assetManager, 150n))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 1n, 3n)
      .and.to.emit(vault, "DepositSettled")
      .withArgs(receiver.address, await asset.getAddress(), 50n, 50n);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(50n);
  });

  it("rejects a second active deposit request for the same owner", async function () {
    const { vault, owner } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(owner).requestDeposit(10n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("keeps a single owner request state across pending and claimable buckets", async function () {
    const { vault, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await expect(vault.connect(owner).requestRedeem(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);

    await settleWithOracle(vault, assetManager, 100n);
    await expect(vault.connect(owner).requestDeposit(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(owner).requestRedeem(10n, owner.address, owner.address);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(10n);
  });

  it("settles first deposit batch and allows claim through deposit entrypoint", async function () {
    const { escrow, vault, asset, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    expect(await asset.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(100n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(100n);

    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.emit(vault, "DepositClaimed")
      .withArgs(owner.address, 100n);

    expect(await vault.totalSupply()).to.equal(100n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("claims through deposit entrypoint and disallows cancelling claimable deposits", async function () {
    const { vault, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoPending);
    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.emit(vault, "DepositClaimed")
      .withArgs(owner.address, 100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
  });

  it("rejects deposit claim entrypoint when receiver/controller mismatch after deposit becomes claimable", async function () {
    const { vault, owner, receiver, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(owner).deposit(0n, receiver.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
    await expect(vault.connect(owner).deposit(0n, owner.address, receiver.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAddress",
    );
  });

  it("rejects deposit claim from unauthorized outsider", async function () {
    const { vault, owner, outsider, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(outsider).deposit(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("reverts deposit claim when global flow is paused after request becomes claimable", async function () {
    const { core, vault, owner, assetManager, authority } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    await core.connect(authority).setGlobalPauseMask(1n);

    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("allows approved operator to claim for owner via deposit", async function () {
    const { vault, owner, operator, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(operator).deposit(0n, owner.address, owner.address))
      .to.emit(vault, "DepositClaimed")
      .withArgs(owner.address, 100n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("reverts deposit when no claimable request exists", async function () {
    const { vault, owner } = await deployFixture();

    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoClaimable);
  });

  it("requires settle manager permission for settleRequests", async function () {
    const { vault, owner, outsider, vaultOwner } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(vaultOwner).setPermissionMask(outsider.address, (1n << 253n) | VAULT_ASSET_MANAGER);
    await expect(settleWithOracle(vault, outsider, 100n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("reverts settleRequests when curator flow is paused", async function () {
    const { core, curator, vault, owner, assetManager, authority } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);

    await expect(settleWithOracle(vault, assetManager, 100n)).to.be.revertedWithCustomError(vault, "FlowPaused");
  });

  it("settle manager settlement updates settlement allowed timestamp with core cooldown", async function () {
    const { core, vault, owner, assetManager } = await deployFixture();

    await core.setNavRequestCooldown(60n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    expect(await vault.settlementAllowedAt()).to.equal(0n);

    const tx = await settleWithOracle(vault, assetManager, 100n);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);

    expect(await vault.settlementAllowedAt()).to.equal(BigInt(block!.timestamp) + 60n);
  });

  it("first settlement initializes fee accrual timestamp and high-water mark without charging fees", async function () {
    const { core, vault, owner, vaultOwner, assetManager } = await deployFixture();

    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await vault
      .connect(vaultOwner)
      .setFees(100_000_000_000_000_000n, packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await settleWithOracle(vault, assetManager, 100n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await vault.curator())).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.totalSupply()).to.equal(100n);
  });

  it("accrues protocol AUM fee shares before deposit settlement", async function () {
    const fixture = await deployFixture();
    const { core, vault, owner, receiver, asset, assetManager } = fixture;

    await seedShares(fixture, owner, 1_000n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);

    await expect(settleWithOracle(vault, assetManager, 1_000n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(111n, 0n, 111n, 0n, 0n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(111n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(100n);
    expect(await vault.totalSupply()).to.equal(1_222n);
  });

  it("splits management fee shares between core and curator", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, receiver, vaultOwner, asset, assetManager } = fixture;

    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);

    await expect(settleWithOracle(vault, assetManager, 1_000n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(22n, 89n, 0n, 111n, 0n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(22n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(89n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(100n);
  });

  it("sends all curator fees to the curator while preserving the protocol AUM fee", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, vaultOwner, assetManager } = fixture;
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, true);
    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);

    await expect(settleWithOracle(vault, assetManager, 1_000n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(111n, 123n, 111n, 123n, 0n);
    expect(await vault.balanceOf(await core.getAddress())).to.equal(111n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(123n);
  });

  it("accrues performance fee above high-water mark and updates the mark", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, receiver, vaultOwner, asset, assetManager } = fixture;

    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedShares(fixture, owner, 1_000n);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);

    await expect(settleWithOracle(vault, assetManager, 1_200n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(6n, 28n, 0n, 0n, 34n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(6n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(28n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(100n);
    expect(await vault.totalSupply()).to.equal(1_120n);
  });

  it("charges performance fee for gains above the post-fee high-water mark", async function () {
    const fixture = await deployFixture();
    const { vault, owner, vaultOwner, assetManager } = fixture;

    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedShares(fixture, owner, 1_000n);

    await settleWithOracle(vault, assetManager, 1_200n);

    await expect(settleWithOracle(vault, assetManager, 1_230n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(0n, 4n, 0n, 0n, 4n);
  });

  it("accrues ladder performance fee across configured profit brackets", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, vaultOwner, assetManager } = fixture;
    const ladderFee = packPerformanceFeeSchedule([
      [500n, 1_000n],
      [1_000n, 1_500n],
      [3_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
    ]);

    await vault.connect(vaultOwner).setFees(0n, ladderFee);
    await seedShares(fixture, owner, 1_000n);

    await expect(settleWithOracle(vault, assetManager, 1_200n))
      .to.emit(vault, "FeesAccrued")
      .withArgs(4n, 17n, 0n, 0n, 21n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(4n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(17n);
    expect(await vault.totalSupply()).to.equal(1_021n);
  });

  it("enforces configured performance fee settlement period", async function () {
    const fixture = await deployFixture();
    const { vault, owner, vaultOwner, assetManager } = fixture;
    const ladderFee = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]], BigInt(MONTH));

    await vault.connect(vaultOwner).setFees(0n, ladderFee);
    await seedShares(fixture, owner, 1_000n);

    await advancePastSettlementCooldown(vault);
    await expectPerformancePeriodCooldown(vault, assetManager);
    await ethers.provider.send("evm_mine", []);

    await increaseTime(MONTH * 2);
    await expect(settleWithOracle(vault, assetManager, 1_200n)).to.emit(vault, "FeesAccrued");

    await advancePastSettlementCooldown(vault);
    await expectPerformancePeriodCooldown(vault, assetManager);
  });

  it("does not accrue performance fee on NAV decrease or recovery below high-water mark", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, receiver, vaultOwner, asset, assetManager } = fixture;

    await vault.connect(vaultOwner).setFees(0n, packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedShares(fixture, owner, 1_000n);

    await asset.mint(receiver.address, 300n);
    await asset.connect(receiver).approve(await vault.escrow(), 300n);

    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_200n);
    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);

    const coreSharesAfterIncrease = await vault.balanceOf(await core.getAddress());
    const curatorSharesAfterIncrease = await vault.balanceOf(await curator.getAddress());

    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 900n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(coreSharesAfterIncrease);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(curatorSharesAfterIncrease);

    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);

    const coreSharesAfterDecrease = await vault.balanceOf(await core.getAddress());
    const curatorSharesAfterDecrease = await vault.balanceOf(await curator.getAddress());

    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_100n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(coreSharesAfterDecrease);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(curatorSharesAfterDecrease);
  });

  it("aggregates fee mints to core and curator once per settlement", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, receiver, vaultOwner, asset, assetManager } = fixture;

    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await vault
      .connect(vaultOwner)
      .setFees(100_000_000_000_000_000n, packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]));
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);

    const tx = await settleWithOracle(vault, assetManager, 1_200n);
    const receipt = await tx.wait();
    const coreAddress = await core.getAddress();
    const curatorAddress = await curator.getAddress();
    const transferLogs = receipt!.logs
      .map((log) => {
        try {
          return vault.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((parsed) => parsed?.name === "Transfer" && parsed.args.from === ethers.ZeroAddress);

    expect(transferLogs.filter((parsed) => parsed!.args.to === coreAddress)).to.have.length(1);
    expect(transferLogs.filter((parsed) => parsed!.args.to === curatorAddress)).to.have.length(1);
  });

  it("lets core finance manager approve a redeem operator and claim settled fee assets externally", async function () {
    const fixture = await deployFixture();
    const { core, escrow, vault, owner, operator, outsider, receiver, asset, assetManager } = fixture;
    const coreAddress = await core.getAddress();
    const vaultAddress = await vault.getAddress();

    await seedShares(fixture, owner, 1_000n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_000n);

    const feeShares = await vault.balanceOf(coreAddress);
    expect(feeShares).to.be.gt(0n);

    await expect(core.connect(outsider).setVaultOperator(vaultAddress, operator.address, true))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(operator).requestRedeem(feeShares, coreAddress, coreAddress))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(operator.address);

    await core.setPermissionMask(outsider.address, (1n << 253n) | CORE_FINANCE_MANAGER);
    await expect(core.connect(outsider).setVaultOperator(vaultAddress, operator.address, true))
      .to.emit(vault, "OperatorSet")
      .withArgs(coreAddress, operator.address, true);
    expect(await vault.isOperator(coreAddress, operator.address)).to.equal(true);

    await vault.connect(operator).requestRedeem(feeShares, coreAddress, coreAddress);
    await settleWithOracle(vault, assetManager, await vault.totalSupply());
    const [claimableAssets] = await escrow.balanceOf(vaultAddress, await asset.getAddress(), coreAddress);
    const receiverBalanceBefore = await asset.balanceOf(receiver.address);

    await expect(core.connect(outsider).claimVaultRedeem(vaultAddress, receiver.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(coreAddress, await asset.getAddress(), claimableAssets);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBefore + claimableAssets);
    expect(await vault.claimableRedeemRequest(0n, coreAddress)).to.equal(0n);
  });

  it("lets core finance manager request redemption of core-owned fee shares", async function () {
    const fixture = await deployFixture();
    const { core, vault, owner, outsider, receiver, asset, assetManager, vaultOwner } = fixture;
    const coreAddress = await core.getAddress();

    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_000n);

    const feeShares = await vault.balanceOf(coreAddress);
    await expect(core.connect(outsider).requestVaultRedeem(await vault.getAddress(), feeShares))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(outsider.address);

    await core.setPermissionMask(outsider.address, (1n << 253n) | CORE_FINANCE_MANAGER);
    await expect(core.connect(outsider).requestVaultRedeem(await vault.getAddress(), feeShares))
      .to.emit(vault, "RedeemRequest")
      .withArgs(coreAddress, coreAddress, 0n, coreAddress, feeShares);

    expect(await vault.pendingRedeemRequest(0n, coreAddress)).to.equal(feeShares);
  });

  it("lets curator finance manager approve a redeem operator and claim settled fee assets externally", async function () {
    const fixture = await deployFixture();
    const {
      curator,
      escrow,
      vault,
      owner,
      operator,
      outsider,
      receiver,
      curatorOwner,
      vaultOwner,
      asset,
      assetManager,
    } = fixture;
    const curatorAddress = await curator.getAddress();
    const vaultAddress = await vault.getAddress();

    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_000n);

    const feeShares = await vault.balanceOf(curatorAddress);
    expect(feeShares).to.be.gt(0n);

    await expect(curator.connect(outsider).setVaultOperator(vaultAddress, operator.address, true))
      .to.be.revertedWithCustomError(curator, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(operator).requestRedeem(feeShares, curatorAddress, curatorAddress))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(operator.address);

    await curator.connect(curatorOwner).setPermissionMask(outsider.address, (1n << 253n) | CURATOR_FINANCE_MANAGER);
    await expect(curator.connect(outsider).setVaultOperator(vaultAddress, operator.address, true))
      .to.emit(vault, "OperatorSet")
      .withArgs(curatorAddress, operator.address, true);
    expect(await vault.isOperator(curatorAddress, operator.address)).to.equal(true);

    await vault.connect(operator).requestRedeem(feeShares, curatorAddress, curatorAddress);
    await settleWithOracle(vault, assetManager, await vault.totalSupply());
    const [claimableAssets] = await escrow.balanceOf(vaultAddress, await asset.getAddress(), curatorAddress);
    const receiverBalanceBefore = await asset.balanceOf(receiver.address);

    await expect(curator.connect(outsider).claimVaultRedeem(vaultAddress, receiver.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(curatorAddress, await asset.getAddress(), claimableAssets);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBefore + claimableAssets);
    expect(await vault.claimableRedeemRequest(0n, curatorAddress)).to.equal(0n);
  });

  it("lets curator finance manager request redemption of curator-owned fee shares", async function () {
    const fixture = await deployFixture();
    const { curator, vault, owner, curatorOwner, vaultOwner, outsider, receiver, asset, assetManager } = fixture;
    const curatorAddress = await curator.getAddress();

    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 1_000n);

    const feeShares = await vault.balanceOf(curatorAddress);
    await expect(curator.connect(outsider).requestVaultRedeem(await vault.getAddress(), feeShares))
      .to.be.revertedWithCustomError(curator, "Unauthorized")
      .withArgs(outsider.address);

    await expect(curator.connect(curatorOwner).requestVaultRedeem(await vault.getAddress(), feeShares))
      .to.emit(vault, "RedeemRequest")
      .withArgs(curatorAddress, curatorAddress, 0n, await curator.getAddress(), feeShares);

    expect(await vault.pendingRedeemRequest(0n, curatorAddress)).to.equal(feeShares);
  });

  it("does not charge AUM fees on pending deposit escrow assets", async function () {
    const fixture = await deployFixture();
    const { core, vault, owner, receiver, asset, assetManager } = fixture;

    await seedShares(fixture, owner, 1_000n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 10_000n);
    await asset.connect(receiver).approve(await vault.escrow(), 10_000n);
    await vault.connect(receiver).requestDeposit(10_000n, receiver.address, receiver.address);

    await settleWithOracle(vault, assetManager, 1_000n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(111n);
  });

  it("advances last fee accrual timestamp and avoids immediate double accrual", async function () {
    const fixture = await deployFixture();
    const { core, vault, owner, receiver, asset, assetManager } = fixture;

    await seedShares(fixture, owner, 1_000n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await increaseTime(YEAR);
    await asset.mint(receiver.address, 101n);
    await asset.connect(receiver).approve(await vault.escrow(), 101n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);

    await settleWithOracle(vault, assetManager, 1_000n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(111n);

    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);
    await vault.connect(receiver).requestDeposit(1n, receiver.address, receiver.address);

    await settleWithOracle(vault, assetManager, 1_000n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(111n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(1n);
  });

  it("keeps failed deposit batch semantics when fee shares are minted first", async function () {
    const fixture = await deployFixture();
    const { core, vault, asset, owner, assetManager } = fixture;

    await seedShares(fixture, owner, 100n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await increaseTime(YEAR);
    await asset.connect(owner).approve(await vault.escrow(), 1n);
    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);

    const tx = settleWithOracle(vault, assetManager, 1_000_000n);
    await expect(tx).to.emit(vault, "FeesAccrued").withArgs(11n, 0n, 11n, 0n, 0n);
    await expect(tx).to.emit(vault, "RequestFailed").withArgs(owner.address, 1n, 1n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(11n);
    expect(await vault.totalSupply()).to.equal(111n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(100n);

    await increaseTime(YEAR);
    await expect(settleWithOracle(vault, assetManager, 1_000_000n)).to.emit(vault, "FeesAccrued");
  });

  it("allows fee-only settlement with empty request queues", async function () {
    const { vault, assetManager } = await deployFixture();

    expect(await vault.settlementAllowedAt()).to.equal(0n);
    await expect(settleWithOracle(vault, assetManager, 0n)).to.emit(vault, "OracleNAVReceived");
    expect(await vault.settlementAllowedAt()).to.be.gt(0n);
  });

  it("does not accrue protocol or curator fees after vault termination", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, vaultOwner, assetManager } = fixture;

    await vault.connect(vaultOwner).setFees(100_000_000_000_000_000n, 0n);
    await seedShares(fixture, owner, 1_000n);
    await core.setProtocolFee(await vault.getAddress(), 100_000_000_000_000_000n, false);
    await vault.connect(vaultOwner).terminate();
    await increaseTime(YEAR);

    await vault.connect(owner).requestRedeem(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 1_000n);

    expect(await vault.balanceOf(await core.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await curator.getAddress())).to.equal(0n);
    expect(await vault.totalSupply()).to.equal(900n);
  });

  it("does not update settlement allowed timestamp on invalid NAV revert after prior settlement", async function () {
    const fixture = await deployFixture();
    const { vault, owner, assetManager } = fixture;

    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(10n, owner.address, owner.address);
    const settleTx = await settleWithOracle(vault, assetManager, 100n);
    await settleTx.wait();
    await vault.connect(owner).redeem(0n, owner.address, owner.address);

    const settlementAllowedAt = await vault.settlementAllowedAt();
    expect(settlementAllowedAt).to.be.gt(0n);

    await vault.connect(owner).requestRedeem(5n, owner.address, owner.address);
    await expect(settleWithOracle(vault, assetManager, 0n)).to.be.revertedWithCustomError(vault, "InvalidAmount");
    expect(await vault.settlementAllowedAt()).to.equal(settlementAllowedAt);
  });

  it("oracle callback settlement still settles through the existing settle manager hook", async function () {
    const { vault, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("fails zero-output deposits without reverting batch and removes failed owner from queue", async function () {
    const { escrow, vault, asset, owner, assetManager } = await deployFixture();

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);
    await expect(settleWithOracle(vault, assetManager, 1_000_000n))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 1n, 1n);

    expect(await asset.balanceOf(owner.address)).to.equal(999_899n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    await escrow.connect(owner).withdraw(await vault.getAddress(), await asset.getAddress(), 1n, owner.address);
    expect(await asset.balanceOf(owner.address)).to.equal(999_900n);
    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoPending);
  });

  it("requests redeem and locks shares without changing total supply", async function () {
    const fixture = await deployFixture();
    const { vault, escrow, owner } = fixture;
    await seedShares(fixture, owner, 100n);

    await expect(vault.connect(owner).requestRedeem(40n, owner.address, owner.address))
      .to.emit(vault, "RedeemRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 40n);

    expect(await vault.balanceOf(owner.address)).to.equal(60n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(40n);
    expect(await vault.totalSupply()).to.equal(100n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(40n);
  });

  it("keeps pending redeems and unclaimed deposits in escrow through cancellation, settlement, and claims", async function () {
    const fixture = await deployFixture();
    const { core, vault, escrow, asset, owner, receiver, vaultOwner, assetManager } = fixture;
    const vaultAddress = await vault.getAddress();
    const escrowAddress = await escrow.getAddress();
    await core.setNavRequestCooldown(1n);
    await seedShares(fixture, owner, 100n);
    await asset.mint(receiver.address, 50n);
    await asset.connect(receiver).approve(escrowAddress, 50n);
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(vaultOwner).setTransferRestricted(true);
    await core.setGlobalPauseMask(1n << 9n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    expect(await vault.balanceOf(vaultAddress)).to.equal(0n);
    expect(await vault.balanceOf(escrowAddress)).to.equal(90n);
    await expect(escrow.connect(owner).withdraw(vaultAddress, vaultAddress, 40n, owner.address))
      .to.be.revertedWithCustomError(escrow, "InsufficientLiquidity");
    await vault.connect(owner).cancelRedeem(owner.address);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(escrowAddress)).to.equal(50n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 150n);
    expect(await vault.balanceOf(escrowAddress)).to.equal(50n);
    expect(await vault.totalSupply()).to.equal(110n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    expect(await escrow.balanceOf(vaultAddress, await asset.getAddress(), owner.address)).to.deep.equal([40n, 0n]);
    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);
    expect(await vault.balanceOf(receiver.address)).to.equal(50n);
    expect(await vault.balanceOf(escrowAddress)).to.equal(0n);
    await vault.connect(owner).redeem(0n, owner.address, owner.address);
    expect(await escrow.balanceOf(vaultAddress, await asset.getAddress(), owner.address)).to.deep.equal([0n, 0n]);
    expect(await vault.balanceOf(vaultAddress)).to.equal(0n);
  });

  it("returns escrow-held pending redeem shares when a timed-out oracle request is reset", async function () {
    const fixture = await deployFixture();
    const { core, vault, escrow, owner, assetManager } = fixture;
    await core.setNavRequestCooldown(1n);
    await core.setOracleRequestTimeout(1n);
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(40n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await increaseTime(2);
    await expect(vault.connect(assetManager).resetRequests())
      .to.emit(vault, "RedeemCancelled").withArgs(owner.address, 40n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.totalSupply()).to.equal(100n);
  });

  it("preserves both escrow share reserves through rejected NAV and an oracle resend", async function () {
    const fixture = await deployFixture();
    const { core, vault, escrow, asset, authority, owner, receiver, assetManager } = fixture;
    const escrowAddress = await escrow.getAddress();
    await core.setNavRequestCooldown(1n);
    await core.setOracleRequestTimeout(1n);
    await seedShares(fixture, owner, 100n);
    await asset.mint(receiver.address, 50n);
    await asset.connect(receiver).approve(escrowAddress, 50n);
    await vault.connect(receiver).requestDeposit(50n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await core.setAllowedPriceFluctuation(10n ** 16n);
    await settleWithOracle(vault, assetManager, 1n);
    expect(await vault.isInvalidPrice()).to.equal(true);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.balanceOf(escrowAddress)).to.equal(90n);
    expect(await vault.totalSupply()).to.equal(150n);

    await vault.connect(authority).resetInvalidPrice(150n);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    const oldRequestId = await vault.activeOracleRequestId();
    await increaseTime(2);
    await vault.connect(assetManager).manualResendOracleRequest();
    const requestId = await vault.activeOracleRequestId();
    expect(requestId).to.not.equal(oldRequestId);
    expect(await vault.balanceOf(escrowAddress)).to.equal(90n);
    const oracle = await ethers.getContractAt("MockUFarmOracle", await core.oracleForVault(await vault.getAddress()));
    await expect(oracle.submitNav(oldRequestId, 150n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "OracleFlowError").withArgs(OracleFlow.InvalidRequest);
    await oracle.submitNav(requestId, 150n, await nextBlockTimestamp());
    expect(await vault.balanceOf(escrowAddress)).to.equal(50n);
    expect(await vault.totalSupply()).to.equal(110n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);
    expect(await vault.balanceOf(escrowAddress)).to.equal(0n);
  });

  it("allows approved operator to request redeem for owner", async function () {
    const fixture = await deployFixture();
    const { vault, owner, operator } = fixture;
    await seedShares(fixture, owner, 100n);

    await expect(vault.connect(operator).requestRedeem(40n, owner.address, owner.address))
      .to.emit(vault, "RedeemRequest")
      .withArgs(owner.address, owner.address, 0n, operator.address, 40n);
  });

  it("rejects invalid redeem request callers and inputs", async function () {
    const fixture = await deployFixture();
    const { vault, owner, outsider, receiver } = fixture;
    await seedShares(fixture, owner, 100n);

    await expect(vault.connect(outsider).requestRedeem(40n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(owner).requestRedeem(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    await expect(vault.connect(owner).requestRedeem(40n, receiver.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("rejects a second active redeem request for the same owner", async function () {
    const fixture = await deployFixture();
    const { vault, owner } = fixture;
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await expect(vault.connect(owner).requestRedeem(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("caps pending redeem queue at ten owners", async function () {
    const fixture = await deployFixture();
    const { vault } = fixture;
    const holders = (await ethers.getSigners()).slice(9, 20);

    for (const holder of holders) {
      await seedShares(fixture, holder, 20n);
    }

    for (const holder of holders.slice(0, 10)) {
      await vault.connect(holder).requestRedeem(10n, holder.address, holder.address);
    }

    await expect(vault.connect(holders[10]).requestRedeem(10n, holders[10].address, holders[10].address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("reverts redeem request when global flow is paused", async function () {
    const fixture = await deployFixture();
    const { core, vault, owner, authority } = fixture;
    await seedShares(fixture, owner, 100n);

    await core.connect(authority).setGlobalPauseMask(1n);

    await expect(vault.connect(owner).requestRedeem(40n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("reverts redeem cancellation when curator flow is paused", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, owner, authority } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);

    await expect(vault.connect(owner).cancelRedeem(owner.address)).to.be.revertedWithCustomError(vault, "FlowPaused");
  });

  it("rejects redeem request when a pending deposit is active for the owner", async function () {
    const fixture = await deployFixture();
    const { vault, asset, owner } = fixture;
    await seedShares(fixture, owner, 100n);
    await asset.connect(owner).approve(await vault.escrow(), 10n);
    await vault.connect(owner).requestDeposit(10n, owner.address, owner.address);

    await expect(vault.connect(owner).requestRedeem(40n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
  });

  it("cancels pending redeem by owner and unlocks shares", async function () {
    const fixture = await deployFixture();
    const { vault, owner } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await expect(vault.connect(owner).cancelRedeem(owner.address))
      .to.emit(vault, "RedeemCancelled")
      .withArgs(owner.address, 40n);

    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
  });

  it("cancels pending redeem by approved operator and unlocks shares", async function () {
    const fixture = await deployFixture();
    const { vault, owner, operator } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await expect(vault.connect(operator).cancelRedeem(owner.address))
      .to.emit(vault, "RedeemCancelled")
      .withArgs(owner.address, 40n);

    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
  });

  it("rejects pending redeem cancellation by settle manager", async function () {
    const fixture = await deployFixture();
    const { vault, owner, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await expect(vault.connect(assetManager).cancelRedeem(owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(assetManager.address);
  });

  it("rejects redeem cancellation by outsider for another owner", async function () {
    const fixture = await deployFixture();
    const { vault, owner, outsider } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await expect(vault.connect(outsider).cancelRedeem(owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("rejects redeem cancellation when no pending redeem exists", async function () {
    const fixture = await deployFixture();
    const { vault, owner } = fixture;
    await seedShares(fixture, owner, 100n);

    await expect(vault.connect(owner).cancelRedeem(owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoPending);
  });

  it("allows a fresh redeem request after redeem cancellation", async function () {
    const fixture = await deployFixture();
    const { vault, owner } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await vault.connect(owner).cancelRedeem(owner.address);

    await expect(vault.connect(owner).requestRedeem(25n, owner.address, owner.address))
      .to.emit(vault, "RedeemRequest")
      .withArgs(owner.address, owner.address, 0n, owner.address, 25n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(25n);
  });

  it("settles redeem request and claims through redeem entrypoint", async function () {
    const fixture = await deployFixture();
    const { vault, escrow, asset, owner, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    await expect(settleWithOracle(vault, assetManager, 100n))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, await asset.getAddress(), 40n, 40n);

    expect(await vault.totalSupply()).to.equal(60n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      40n,
      0n,
    ]);

    const balanceBeforeClaim = await asset.balanceOf(owner.address);
    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await asset.getAddress(), 40n);
    expect(await asset.balanceOf(owner.address)).to.equal(balanceBeforeClaim + 40n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
  });

  it("lets beneficiaries withdraw settled redeem assets directly from escrow and clear vault claim state", async function () {
    const fixture = await deployFixture();
    const { escrow, vault, asset, owner, receiver, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    const receiverBalanceBefore = await asset.balanceOf(receiver.address);
    await escrow.connect(owner).withdraw(await vault.getAddress(), await asset.getAddress(), 40n, receiver.address);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBefore + 40n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);

    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await asset.getAddress(), 0n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
  });

  it("clears redeem claim and unlocks escrow when claim transfer fails", async function () {
    const fixture = await deployFixture();
    const { escrow, vault, asset, owner, receiver, assetManager } = fixture;
    const vaultAddress = await vault.getAddress();
    const assetAddress = await asset.getAddress();

    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    await asset.setTransferReverts(true);

    await expect(vault.connect(owner).redeem(0n, receiver.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, assetAddress, 0n);

    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await escrow.balanceOf(vaultAddress, assetAddress, owner.address)).to.deep.equal([40n, 0n]);

    await asset.setTransferReverts(false);
    await escrow.connect(owner).withdraw(vaultAddress, assetAddress, 40n, receiver.address);
    expect(await escrow.balanceOf(vaultAddress, assetAddress, owner.address)).to.deep.equal([0n, 0n]);
  });

  it("settles pending redeems in request order while clearing the queue once", async function () {
    const fixture = await deployFixture();
    const { vault, asset, owner, receiver, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await vault.connect(receiver).requestRedeem(25n, receiver.address, receiver.address);

    await expect(settleWithOracle(vault, assetManager, 200n))
      .to.emit(vault, "RedeemSettled")
      .withArgs(owner.address, await asset.getAddress(), 40n, 40n)
      .and.to.emit(vault, "RedeemSettled")
      .withArgs(receiver.address, await asset.getAddress(), 25n, 25n);

    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.claimableRedeemRequest(0n, receiver.address)).to.equal(25n);
    await expect(settleWithOracle(vault, assetManager, 200n)).to.emit(vault, "OracleNAVReceived");
  });

  it("does not let one failed redeem escrow credit block the rest of the batch", async function () {
    const fixture = await deployFixture();
    const { vault, asset, owner, receiver, assetManager } = fixture;

    await seedShares(fixture, owner, 100n);
    await asset.mint(receiver.address, 100n);
    await asset.connect(receiver).approve(await vault.escrow(), 100n);
    await vault.connect(receiver).requestDeposit(100n, receiver.address, receiver.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(receiver).deposit(0n, receiver.address, receiver.address);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await vault.connect(receiver).requestRedeem(25n, receiver.address, receiver.address);

    await asset.setTransferFromRevertAmount(40n);

    await expect(settleWithOracle(vault, assetManager, 200n))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 2n, 3n)
      .and.to.emit(vault, "RedeemSettled")
      .withArgs(receiver.address, await asset.getAddress(), 25n, 25n);

    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, receiver.address)).to.equal(25n);
  });

  it("isolates a redeem whose payout feed becomes invalid before the oracle callback", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, asset, customAsset, customAssetFeed, owner, receiver, assetManager, vaultOwner } =
      fixture;
    const vaultAddress = await vault.getAddress();
    const customAssetAddress = await customAsset.getAddress();

    await core.setNavRequestCooldown(1n);
    await core.setVaultOracle(vaultAddress, await oracle.getAddress());
    await seedShares(fixture, owner, 100n);
    await seedShares(fixture, receiver, 100n);
    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);
    await customAsset.mint(vaultAddress, 100n);

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + YEAR);
    const ownerRedeem = await makeSignedRequest("redeem", vault, owner, {
      asset: customAssetAddress,
      amount: 40n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    const receiverRedeem = await makeSignedRequest("redeem", vault, receiver, {
      asset: await asset.getAddress(),
      amount: 25n,
      controller: receiver.address,
      owner: receiver.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    await vault
      .connect(assetManager)
      .getFunction(
        SIGNED_SETTLE_SELECTOR,
      )([], [ownerRedeem, receiverRedeem]);
    await customAssetFeed.setShouldRevert(true);

    await expect(oracle.submitNav(await vault.activeOracleRequestId(), 200n, await nextBlockTimestamp()))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 2n, 1n)
      .and.to.emit(vault, "RedeemSettled")
      .withArgs(receiver.address, await asset.getAddress(), 25n, 25n);

    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, receiver.address)).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, receiver.address)).to.equal(25n);
  });

  it("settles mixed deposit and redeem in one batch using starting supply pricing", async function () {
    const fixture = await deployFixture();
    const { vault, escrow, asset, owner, receiver, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);

    const depositAmount = 50n;
    await asset.mint(receiver.address, depositAmount);
    await asset.connect(receiver).approve(await vault.escrow(), depositAmount);
    await vault.connect(receiver).requestDeposit(depositAmount, receiver.address, receiver.address);

    await settleWithOracle(vault, assetManager, 200n);

    expect(await vault.totalSupply()).to.equal(85n);
    expect(await vault.claimableDepositRequest(0n, receiver.address)).to.equal(50n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await vault.pendingDepositRequest(0n, receiver.address)).to.equal(0n);
    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.balanceOf(await escrow.getAddress())).to.equal(25n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      80n,
      0n,
    ]);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(70n);
  });

  it("claims redeem through redeem entrypoint and claimable redeem cannot be cancelled", async function () {
    const fixture = await deployFixture();
    const { vault, owner, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(owner).cancelRedeem(owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoPending);
    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address)).to.emit(vault, "RedeemClaimed");
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
  });

  it("enforces redeem claim access and edge cases", async function () {
    const fixture = await deployFixture();
    const { escrow, vault, asset, owner, operator, outsider, receiver, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);

    await expect(vault.connect(outsider).redeem(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(operator).redeem(0n, receiver.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(operator.address);

    const ownerBalanceBefore = await asset.balanceOf(owner.address);
    await expect(vault.connect(operator).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await asset.getAddress(), 40n);
    expect(await asset.balanceOf(owner.address)).to.equal(ownerBalanceBefore + 40n);

    await vault.connect(owner).requestRedeem(20n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 60n);
    const receiverBalanceBefore = await asset.balanceOf(receiver.address);
    await expect(vault.connect(owner).redeem(0n, receiver.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await asset.getAddress(), 20n);
    expect(await asset.balanceOf(receiver.address)).to.equal(receiverBalanceBefore + 20n);
    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoClaimable);
  });

  it("fails redeem settlement for insufficient liquidity, unlocks shares, and removes failed bucket", async function () {
    const fixture = await deployFixture();
    const { vault, owner, assetManager } = fixture;
    await seedShares(fixture, owner, 100n);
    await vault.connect(owner).requestRedeem(80n, owner.address, owner.address);

    await expect(settleWithOracle(vault, assetManager, 1_000n))
      .to.emit(vault, "RequestFailed")
      .withArgs(owner.address, 2n, 2n);

    expect(await vault.pendingRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(100n);
    expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.totalSupply()).to.equal(100n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    await expect(settleWithOracle(vault, assetManager, 1_000n)).to.emit(vault, "OracleNAVReceived");
  });

  it("starts an oracle request through the configured vault oracle", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);

    expect(await vault.activeOracleRequestId()).to.equal(1n);
    expect(await oracle.vaultByRequestId(1n)).to.equal(await vault.getAddress());
  });

  it("starts an oracle request through the wildcard oracle", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(ethers.ZeroAddress, await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);
  });

  it("rejects repeated oracle request start while one is active", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    expect(await vault.activeOracleRequestId()).to.equal(1n);
  });

  it("active oracle request blocks new requests and cancellations but allows claims", async function () {
    const fixture = await deployFixture();
    const { core, vault, asset, oracle, owner, receiver, assetManager } = fixture;
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    await asset.mint(receiver.address, 10n);
    await asset.connect(receiver).approve(await vault.escrow(), 10n);
    await vault.connect(receiver).requestDeposit(10n, receiver.address, receiver.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(receiver).requestDeposit(1n, receiver.address, receiver.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(vault.connect(receiver).cancelDeposit(receiver.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(settleWithOracle(vault, assetManager, 100n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);

    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address)).to.emit(vault, "DepositClaimed");
  });

  it("active oracle request blocks redeem request and cancellation", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, owner, assetManager } = fixture;
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(10n, owner.address, owner.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(owner).requestRedeem(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(vault.connect(owner).cancelRedeem(owner.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
  });

  it("allows redeem claim while an oracle request is active", async function () {
    const fixture = await deployFixture();
    const { core, vault, oracle, owner, receiver, asset, assetManager } = fixture;
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);

    await asset.mint(receiver.address, 10n);
    await asset.connect(receiver).approve(await vault.escrow(), 10n);
    await vault.connect(receiver).requestDeposit(10n, receiver.address, receiver.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.emit(vault, "RedeemClaimed")
      .withArgs(owner.address, await asset.getAddress(), 40n);
  });

  it("oracle callback settles the active request and clears oracle state", async function () {
    const { core, vault, escrow, asset, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    const valuationTimestamp = await nextBlockTimestamp();
    await expect(oracle.submitNav(1n, 100n, valuationTimestamp))
      .to.emit(vault, "OracleNAVReceived")
      .withArgs(await oracle.getAddress(), 1n, 100n, valuationTimestamp);

    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      0n,
      0n,
    ]);
    expect(await vault.settlementAllowedAt()).to.not.equal(0n);
  });

  it("rejects NAV valuations older than the active oracle request", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setNavRequestCooldown(60n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    const requestTx = await vault.connect(assetManager).getFunction("settleRequests()")();
    const requestReceipt = await requestTx.wait();
    const requestBlock = await ethers.provider.getBlock(requestReceipt!.blockNumber);
    const requestedAt = BigInt(requestBlock!.timestamp);

    await expect(oracle.submitNav(1n, 100n, requestedAt - 1n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);
    expect(await vault.activeOracleRequestId()).to.equal(1n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);

    await expect(oracle.submitNav(1n, 100n, requestedAt)).to.emit(vault, "OracleNAVReceived");
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("rejects oracle callback from wrong caller wrong id zero timestamp and callback pause", async function () {
    const { core, curator, vault, oracle, owner, outsider, assetManager, authority } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(outsider).onOracleNav(1n, 100n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await oracle.requestNav(await vault.getAddress());
    await expect(oracle.submitNav(2n, 100n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
    await expect(oracle.submitNav(1n, 100n, 0n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);

    await core.setNavRequestCooldown(60n);
    const latestBlock = await ethers.provider.getBlock("latest");
    const staleTimestamp = BigInt(latestBlock!.timestamp - 61);
    await expect(oracle.submitNav(1n, 100n, staleTimestamp))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidValuationTime);

    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);
    await expect(oracle.submitNav(1n, 100n, await nextBlockTimestamp())).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("oracle request and callback respect dedicated pause bits", async function () {
    const { core, vault, oracle, owner, assetManager, authority } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    await core.connect(authority).setGlobalPauseMask(1n << 5n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
    await core.connect(authority).setGlobalPauseMask(0n);

    await vault.connect(assetManager).getFunction("settleRequests()")();
    await core.connect(authority).setGlobalPauseMask(1n << 6n);
    await expect(oracle.submitNav(1n, 100n, await nextBlockTimestamp())).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
  });

  it("accepts callback from request oracle after rotation and allows reset after timeout policy update", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    const oracleB = await ethers.deployContract("MockUFarmOracle");
    await core.setVaultOracle(await vault.getAddress(), await oracleB.getAddress());

    await oracle.submitNav(1n, 100n, await nextBlockTimestamp());
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(owner).requestDeposit(50n, owner.address, owner.address);
    await ethers.provider.send("evm_increaseTime", [300]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await core.setOracleRequestTimeout(1n);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(assetManager).resetRequests()).to.emit(vault, "OracleRequestReset").withArgs(1n);
  });

  it("rejects oracle request start without manager permission oracle or request id", async function () {
    const { core, vault, oracle, outsider, assetManager, vaultOwner } = await deployFixture();

    await expect(vault.connect(outsider).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Invalid);

    await vault
      .connect(vaultOwner)
      .setPermissionMask(assetManager.address, (1n << 253n) | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    await expect(
      vault
        .connect(assetManager)
        .getFunction(
          SIGNED_SETTLE_SELECTOR,
        )([], []),
    )
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);

    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await oracle.setNextRequestId(0n);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidRequest);
  });

  it("enforces NAV request cooldown after settlement", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setNavRequestCooldown(300n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, assetManager, 100n);
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    await vault.connect(owner).requestRedeem(10n, owner.address, owner.address);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);

    await ethers.provider.send("evm_increaseTime", [300]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(assetManager).getFunction("settleRequests()")()).to.emit(vault, "OracleRequestStarted");
  });

  it("resets timed out oracle request and clears pending request queues", async function () {
    const { core, escrow, vault, oracle, owner, asset, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(60n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(assetManager).resetRequests())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.NotTimedOut);

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).resetRequests()).to.emit(vault, "OracleRequestReset").withArgs(1n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await asset.balanceOf(owner.address)).to.equal(999_900n);
    expect(await escrow.balanceOf(await vault.getAddress(), await asset.getAddress(), owner.address)).to.deep.equal([
      100n,
      0n,
    ]);
  });

  it("manual resend replaces timed out oracle request and leaves pending request intact", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(60n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).manualResendOracleRequest())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 2n)
      .and.to.emit(vault, "OracleRequestResent")
      .withArgs(2n);
    expect(await vault.activeOracleRequestId()).to.equal(2n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
  });

  it("manual resend after oracle rotation uses the current oracle", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(1n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    const oracleB = await ethers.deployContract("MockUFarmOracle");
    await core.setVaultOracle(await vault.getAddress(), await oracleB.getAddress());
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).manualResendOracleRequest())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracleB.getAddress(), 1n)
      .and.to.emit(vault, "OracleRequestResent")
      .withArgs(1n);
    await expect(oracle.submitNav(1n, 100n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(await oracle.getAddress());
    await oracleB.submitNav(1n, 100n, await nextBlockTimestamp());

    expect(await vault.activeOracleRequestId()).to.equal(0n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
  });

  it("allows reset after the minimum non-zero oracle timeout", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(1n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).resetRequests()).to.emit(vault, "OracleRequestReset").withArgs(1n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("allows manual resend after the minimum non-zero oracle timeout", async function () {
    const { core, vault, oracle, owner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(1n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).manualResendOracleRequest())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 2n)
      .and.to.emit(vault, "OracleRequestResent")
      .withArgs(2n);
    expect(await vault.activeOracleRequestId()).to.equal(2n);
  });

  it("allows manual resend for empty fee-only oracle requests", async function () {
    const { core, vault, oracle, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(1n);
    await vault.connect(assetManager).getFunction("settleRequests()")();
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(assetManager).manualResendOracleRequest())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 2n)
      .and.to.emit(vault, "OracleRequestResent")
      .withArgs(2n);
    expect(await vault.activeOracleRequestId()).to.equal(2n);
  });

  it("requires active request and settle manager for oracle reset and resend", async function () {
    const { core, vault, oracle, owner, outsider, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

    await expect(vault.connect(assetManager).resetRequests())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.NoneActive);
    await expect(vault.connect(assetManager).manualResendOracleRequest())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.NoneActive);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await expect(vault.connect(outsider).resetRequests())
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
    await expect(vault.connect(outsider).manualResendOracleRequest())
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("allows vault owner with full initial permissions to reset timed out oracle request", async function () {
    const { core, vault, oracle, owner, vaultOwner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(60n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(vaultOwner).resetRequests()).to.emit(vault, "OracleRequestReset").withArgs(1n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });

  it("allows non-owner settle manager to reset timed out oracle request", async function () {
    const { core, vault, oracle, owner, outsider, vaultOwner, assetManager } = await deployFixture();
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await core.setOracleRequestTimeout(60n);
    await vault.connect(vaultOwner).setPermissionMask(outsider.address, (1n << 253n) | VAULT_SETTLE_MANAGER);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).getFunction("settleRequests()")();

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(outsider).resetRequests()).to.emit(vault, "OracleRequestReset").withArgs(1n);
    expect(await vault.activeOracleRequestId()).to.equal(0n);
  });
});
