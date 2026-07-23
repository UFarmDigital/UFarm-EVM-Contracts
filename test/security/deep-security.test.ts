import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { CROSS_CHAIN_ADAPTER_ID, readCrossChainOutbox } from "../cross-chain/helpers";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const MEMBER = 1n << 253n;
const CORE_CURATOR_REGISTRAR = 1n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const CORE_ORACLE_MANAGER = 1n << 2n;
const CORE_ADAPTER_MANAGER = 1n << 3n;
const CORE_PRICE_GUARD_MANAGER = 1n << 7n;
const CORE_CROSSCHAIN_GUARD_MANAGER = 1n << 8n;
const VAULT_ASSET_MANAGER = 1n;
const VAULT_SETTLE_MANAGER = 1n << 1n;
const VAULT_CONFIG_MANAGER = 1n << 2n;
const VAULT_CUSTOMER_MANAGER = 1n << 3n;

const ADAPTER_ID = ethers.id("ufarm.adapter.arbitrary");
const RequestState = { NoBatch: 4n };
const OracleFlow = { Active: 3n, Cooldown: 6n, InvalidPrice: 8n };
const CrossChainFlow = { AccountingChainOnly: 2n, Active: 4n };
const MessageType = {
  TransferRequest: 0n,
  TransferApproval: 1n,
  TransferSent: 2n,
  TransferReceipt: 3n,
  Reset: 4n,
};
const SessionState = {
  Idle: 0n,
  ApprovalRequested: 1n,
  TransferDispatched: 2n,
  AwaitingSatelliteCompletion: 3n,
};
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_INVALID_SIGNATURE = "0xffffffff";

async function deployVaultFixture() {
  const [
    authority,
    registrar,
    curatorOwner,
    vaultOwner,
    owner,
    operator,
    settleManager,
    configManager,
    customerManager,
    assetManager,
    outsider,
    receiver,
    guardManager,
  ] = await ethers.getSigners();

  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority);
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const oracle = await ethers.deployContract("MockUFarmOracle");
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const customAsset = await ethers.deployContract("MockERC20", ["Euro Coin", "EUROC", 18]);
  const adapter = await ethers.deployContract("MockVaultAdapter", [ADAPTER_ID]);

  await core.setPermissionMask(
    registrar.address,
    MEMBER | CORE_CURATOR_REGISTRAR | CORE_ORACLE_MANAGER | CORE_ADAPTER_MANAGER,
  );
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, customAsset);
  await core.setVaultAdapter(ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("deep-security-curator"));
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
      ethers.id("deep-security-vault"),
      vaultOwner.address,
      "UFarm Deep Security Vault",
      "uDSEC",
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
  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(configManager.address, MEMBER | VAULT_CONFIG_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(customerManager.address, VAULT_CUSTOMER_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, MEMBER | VAULT_ASSET_MANAGER);
  await vault.connect(owner).setOperator(operator.address, true);

  for (const signer of [owner, receiver]) {
    await asset.mint(signer.address, 1_000_000n);
    await asset.connect(signer).approve(await escrow.getAddress(), 1_000_000n);
    await customAsset.mint(signer.address, 1_000_000n);
    await customAsset.connect(signer).approve(await escrow.getAddress(), 1_000_000n);
  }

  return {
    core,
    curator,
    escrow,
    oracle,
    asset,
    customAsset,
    adapter,
    vault,
    vaultOwner,
    owner,
    operator,
    settleManager,
    configManager,
    customerManager,
    assetManager,
    outsider,
    receiver,
    guardManager,
  };
}

async function deployCrossChainFixture(accountingChainId?: bigint) {
  const [authority, registrar, curatorOwner, vaultOwner, owner, assetManager, settleManager, outsider] =
    await ethers.getSigners();
  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority, { accountingChainId });
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const router = await ethers.deployContract("MockCCIPRouter");
  const feeToken = await ethers.deployContract("MockERC20", ["Fee Token", "FEE", 18]);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const adapter = await ethers.deployContract("CrossChainAdapter");

  await core.setPermissionMask(
    registrar.address,
    MEMBER | CORE_CURATOR_REGISTRAR | CORE_CONFIG_MANAGER | CORE_ADAPTER_MANAGER,
  );
  await core.setPermissionMask(assetManager.address, MEMBER | CORE_CROSSCHAIN_GUARD_MANAGER);
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, feeToken);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("deep-xchain-curator"));
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
      ethers.id("deep-xchain-vault"),
      vaultOwner.address,
      "UFarm Deep XChain Vault",
      "uDX",
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

  await vault.connect(vaultOwner).setPermissionMask(assetManager.address, MEMBER | VAULT_ASSET_MANAGER);
  await vault.connect(vaultOwner).setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER);
  await core.connect(registrar).setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());

  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);
  await asset.mint(await vault.getAddress(), 1_000_000n);
  await feeToken.mint(await vault.getAddress(), 1_000_000n);

  return { core, vault, router, feeToken, asset, adapter, owner, assetManager, settleManager, outsider, registrar };
}

async function configureCrossChain(
  fixture: Awaited<ReturnType<typeof deployCrossChainFixture>>,
  remoteChainId: bigint,
  selector = 4_949_039_107_694_359_620n,
) {
  const { core, registrar, router, feeToken, asset } = fixture;
  await core.connect(registrar).setCCIPSelector(remoteChainId, selector);
  await core.connect(registrar).setCrossChainRouter(await router.getAddress());
  await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
  await core.connect(registrar).setCrossChainToken(await asset.getAddress());
  await core.connect(registrar).setCrossChainGasLimit(500_000n);
}

function encodeCrossChainMessage(
  messageType: bigint,
  sourceChainId: bigint,
  destinationChainId: bigint,
  sessionNonce: bigint,
  amount: bigint,
) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
    [1n, messageType, sourceChainId, destinationChainId, sessionNonce, amount],
  );
}

async function deliverCrossChainMessage({
  router,
  vault,
  messageId,
  sourceChainSelector,
  messageType,
  sourceChainId,
  destinationChainId,
  sessionNonce,
  amount,
  destTokenAmounts = [],
}: {
  router: any;
  vault: any;
  messageId: string;
  sourceChainSelector: bigint;
  messageType: bigint;
  sourceChainId: bigint;
  destinationChainId: bigint;
  sessionNonce: bigint;
  amount: bigint;
  destTokenAmounts?: { token: string; amount: bigint }[];
}) {
  return router.deliver(await vault.getAddress(), {
    messageId: ethers.keccak256(ethers.toUtf8Bytes(messageId)),
    sourceChainSelector,
    sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
    data: encodeCrossChainMessage(messageType, sourceChainId, destinationChainId, sessionNonce, amount),
    destTokenAmounts,
  });
}

async function nextBlockTimestamp() {
  const latest = await ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp + 1);
}

async function increaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function advancePastSettlementCooldown(vault: any) {
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
}

async function settleWithOracle(vault: any, signer: any, nav: bigint) {
  const core = await ethers.getContractAt("UFarmCore", await vault.core());
  const oracle = await ethers.getContractAt("MockUFarmOracle", await core.oracleForVault(await vault.getAddress()));
  const settlementAllowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (settlementAllowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(settlementAllowedAt)]);
  }
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  return oracle.submitNav(requestId, nav, await nextBlockTimestamp());
}

async function seedShares(fixture: Awaited<ReturnType<typeof deployVaultFixture>>, holder: any, amount: bigint) {
  const { vault, settleManager } = fixture;
  await vault.connect(holder).requestDeposit(amount, holder.address, holder.address);
  await settleWithOracle(vault, settleManager, amount);
  await vault.connect(holder).deposit(0n, holder.address, holder.address);
}

async function makeClientVerification(vault: any, signer: any, client: string, tier: bigint, validTill: bigint) {
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
    { client, vault: await vault.getAddress(), tier, validTill },
  );

  return { signature, validTill, tier };
}

async function makeSignedRequest(
  kind: "deposit" | "redeem",
  vault: any,
  signer: any,
  request: {
    asset: string;
    amount: bigint;
    minOutputAmount?: bigint;
    controller: string;
    owner: string;
    nonce: bigint;
    deadline: bigint;
  },
  verifyingContract = "",
) {
  const chain = await ethers.provider.getNetwork();
  const primaryType = kind === "deposit" ? "SignedDepositRequest" : "SignedRedeemRequest";
  const requestParams = {
    asset: request.asset,
    amount: request.amount,
    minOutputAmount: request.minOutputAmount ?? 0n,
    controller: request.controller,
    owner: request.owner,
  };
  const signature = await signer.signTypedData(
    {
      name: "UFarmVault",
      version: "2",
      chainId: chain.chainId,
      verifyingContract: verifyingContract || (await vault.getAddress()),
    },
    {
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
    },
    { request: requestParams, nonce: request.nonce, deadline: request.deadline },
  );

  return { request: requestParams, nonce: request.nonce, deadline: request.deadline, signature };
}

describe("UFarm deep security scenarios", function () {
  it("rejects oracle callbacks from a newly configured oracle for an older in-flight request", async function () {
    const { core, vault, oracle, owner, settleManager } = await deployVaultFixture();
    const oracleB = await ethers.deployContract("MockUFarmOracle");
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(settleManager).getFunction("settleRequests()")();
    const activeRequestId = await vault.activeOracleRequestId();
    expect(activeRequestId).to.equal(1n);

    await core.setVaultOracle(await vault.getAddress(), await oracleB.getAddress());
    await oracleB.setNextRequestId(activeRequestId);
    await oracleB.requestNav(await vault.getAddress());

    await expect(oracleB.submitNav(activeRequestId, 100n, await nextBlockTimestamp()))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(await oracleB.getAddress());
    expect(await vault.activeOracleRequestId()).to.equal(activeRequestId);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);

    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await oracle.submitNav(activeRequestId, 100n, await nextBlockTimestamp());
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(100n);
  });

  it("documents direct range and tier checks while signed curator batches can bypass them", async function () {
    const { vault, asset, owner, settleManager, configManager, vaultOwner } = await deployVaultFixture();
    await vault.connect(configManager).setInvestmentRange(10n, 20n);
    await vault.connect(configManager).setClientTier(2n);

    await expect(vault.connect(owner).requestDeposit(30n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidSignature",
    );
    await vault.connect(configManager).setClientTier(0n);
    await expect(vault.connect(owner).requestDeposit(30n, owner.address, owner.address)).to.be.revertedWithCustomError(
      vault,
      "InvalidAmount",
    );
    await vault.connect(configManager).setClientTier(2n);

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const signedDeposit = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 30n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const signedSettleRequests = vault
      .connect(settleManager)
      .getFunction(
        "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])",
      );

    await signedSettleRequests([signedDeposit], []);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(30n);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
  });

  it("does not consume signed request nonces for rejected signatures or inactive requests", async function () {
    const { vault, asset, owner, outsider, settleManager, vaultOwner } = await deployVaultFixture();
    await vault
      .connect(vaultOwner)
      .setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const signedSettleRequests = vault
      .connect(settleManager)
      .getFunction(
        "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])",
      );
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    const wrongDomainDeposit = await makeSignedRequest(
      "deposit",
      vault,
      owner,
      {
        asset: await asset.getAddress(),
        amount: 100n,
        controller: owner.address,
        owner: owner.address,
        nonce: 0n,
        deadline,
      },
      outsider.address,
    );
    await expect(signedSettleRequests([wrongDomainDeposit], []))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(0n);

    const unsupportedAsset = await ethers.deployContract("MockERC20", ["Unsupported", "BAD", 18]);
    const unsupportedDeposit = await makeSignedRequest("deposit", vault, owner, {
      asset: await unsupportedAsset.getAddress(),
      amount: 100n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await expect(signedSettleRequests([unsupportedDeposit], []))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(0n);
  });

  it("requires current customer manager permission when consuming tier attestations", async function () {
    const { vault, customAsset, owner, customerManager, configManager, vaultOwner } = await deployVaultFixture();
    const requestCustomDeposit = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");
    const validTill = (await nextBlockTimestamp()) + 3600n;

    await vault.connect(configManager).setClientTier(2n);
    const verification = await makeClientVerification(vault, customerManager, owner.address, 2n, validTill);
    await vault.connect(vaultOwner).setPermissionMask(customerManager.address, 0n);

    await expect(requestCustomDeposit(await customAsset.getAddress(), 10n, owner.address, owner.address, verification))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(customerManager.address);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("prevents operators from redirecting settled redeem claims to themselves", async function () {
    const fixture = await deployVaultFixture();
    const { vault, asset, owner, operator, receiver, settleManager } = fixture;
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);

    const operatorBalanceBefore = await asset.balanceOf(operator.address);
    await expect(vault.connect(operator).redeem(0n, operator.address, owner.address))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(operator.address);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(40n);
    expect(await asset.balanceOf(operator.address)).to.equal(operatorBalanceBefore);

    await vault.connect(owner).redeem(0n, receiver.address, owner.address);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await asset.balanceOf(receiver.address)).to.equal(1_000_040n);
  });

  it("latches invalid prices without settling and only core price guards can reset", async function () {
    const fixture = await deployVaultFixture();
    const { core, vault, oracle, owner, settleManager, guardManager, outsider } = fixture;
    await seedShares(fixture, owner, 100n);
    await core.setAllowedPriceFluctuation(1_000_000_000_000_000_000n / 10n);

    await vault.connect(owner).requestDeposit(10n, owner.address, owner.address);
    await advancePastSettlementCooldown(vault);
    await vault.connect(settleManager).getFunction("settleRequests()")();
    await oracle.submitNav(await vault.activeOracleRequestId(), 200n, await nextBlockTimestamp());

    expect(await vault.isInvalidPrice()).to.equal(true);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(10n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.InvalidPrice);
    await expect(vault.connect(outsider).resetInvalidPrice(100n))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);

    await core.setPermissionMask(guardManager.address, MEMBER | CORE_PRICE_GUARD_MANAGER);
    await vault.connect(guardManager).resetInvalidPrice(100n);
    await settleWithOracle(vault, settleManager, 100n);
    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(10n);
  });

  it("keeps all custody-mutating flows locked while an oracle request is active", async function () {
    const { vault, adapter, asset, owner, settleManager, assetManager } = await deployVaultFixture();
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(settleManager).getFunction("settleRequests()")();

    await expect(vault.connect(owner).requestDeposit(50n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    await expect(
      vault.connect(assetManager).executeAdapter(ADAPTER_ID, adapter.interface.encodeFunctionData("echoUint256", [0n])),
    )
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);

    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(100n);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("does not leave router allowances after failed cross-chain send", async function () {
    const fixture = await deployCrossChainFixture();
    const { vault, adapter, router, feeToken, asset, assetManager } = fixture;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, destinationChainId);
    await router.setFee(123n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );

    expect(await feeToken.allowance(await vault.getAddress(), await router.getAddress())).to.equal(0n);
    expect(await asset.allowance(await vault.getAddress(), await router.getAddress())).to.equal(0n);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(true);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("does not leave router allowances when fee token and transfer token are the same after failed send", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, adapter, router, asset, assetManager, registrar } = fixture;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, destinationChainId);
    await core.connect(registrar).setCrossChainFeeToken(await asset.getAddress());
    await router.setFee(10n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );

    expect(await asset.allowance(await vault.getAddress(), await router.getAddress())).to.equal(0n);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(true);
  });

  it("rejects stale cross-chain approvals from an older satellite session", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { vault, adapter, router, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const destinationChainId = 42_161n;
    const accountingSelector = 8_001n;
    await configureCrossChain(fixture, accountingChainId, accountingSelector);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);

    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("reset-before-stale-approval")),
      sourceChainSelector: accountingSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.Reset, accountingChainId, localChainId, 1n, 0n),
      destTokenAmounts: [],
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 200n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);

    await expect(
      router.deliver(await vault.getAddress(), {
        messageId: ethers.keccak256(ethers.toUtf8Bytes("stale-approval")),
        sourceChainSelector: accountingSelector,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
        data: encodeCrossChainMessage(MessageType.TransferApproval, localChainId, destinationChainId, 1n, 100n),
        destTokenAmounts: [],
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("rejects stale cross-chain receipts from an older accounting session", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, adapter, router, assetManager, registrar, feeToken } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const destinationChainId = 42_161n;
    const destinationSelector = 7_001n;
    await configureCrossChain(fixture, destinationChainId, destinationSelector);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 50n]),
      );
    await core.connect(registrar).setCCIPSelector(destinationChainId, destinationSelector);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("receipt-1")),
      sourceChainSelector: destinationSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferReceipt, localChainId, destinationChainId, 1n, 49n),
      destTokenAmounts: [],
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 60n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);

    await expect(
      router.deliver(await vault.getAddress(), {
        messageId: ethers.keccak256(ethers.toUtf8Bytes("stale-receipt")),
        sourceChainSelector: destinationSelector,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
        data: encodeCrossChainMessage(MessageType.TransferReceipt, localChainId, destinationChainId, 1n, 49n),
        destTokenAmounts: [],
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores accounting-chain transfer requests while a reset outbox is pending", async function () {
    const fixture = await deployCrossChainFixture();
    const { vault, adapter, router, assetManager } = fixture;
    const sideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const sideSelector = 7_001n;
    await configureCrossChain(fixture, sideChainId, sideSelector);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("manualResetCrossChainSession", [sideChainId]),
      );
    const resetOutbox = await readCrossChainOutbox(ethers, vault);
    expect(resetOutbox.exists).to.equal(true);
    expect(resetOutbox.message.messageType).to.equal(MessageType.Reset);

    await expect(
      router.deliver(await vault.getAddress(), {
        messageId: ethers.keccak256(ethers.toUtf8Bytes("request-while-reset-outbox-pending")),
        sourceChainSelector: sideSelector,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
        data: encodeCrossChainMessage(MessageType.TransferRequest, sideChainId, destinationChainId, 1n, 100n),
        destTokenAmounts: [],
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");
    const outboxAfterRequest = await readCrossChainOutbox(ethers, vault);
    expect(outboxAfterRequest.exists).to.equal(true);
    expect(outboxAfterRequest.message.messageType).to.equal(MessageType.Reset);
  });

  it("keeps a satellite TransferSent outbox recoverable when a delayed reset arrives", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { core, vault, adapter, router, assetManager, registrar } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const accountingSelector = 8_001n;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, accountingChainId, accountingSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, 7_001n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);

    await router.setFailSend(true);
    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("approval-queues-transfer-sent")),
      sourceChainSelector: accountingSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferApproval, localChainId, destinationChainId, 1n, 100n),
      destTokenAmounts: [],
    });
    const transferOutbox = await readCrossChainOutbox(ethers, vault);
    expect(transferOutbox.exists).to.equal(true);
    expect(transferOutbox.message.messageType).to.equal(MessageType.TransferSent);

    await expect(
      router.deliver(await vault.getAddress(), {
        messageId: ethers.keccak256(ethers.toUtf8Bytes("delayed-reset-while-transfer-sent-outbox")),
        sourceChainSelector: accountingSelector,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
        data: encodeCrossChainMessage(MessageType.Reset, accountingChainId, localChainId, 1n, 0n),
        destTokenAmounts: [],
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    const outboxAfterReset = await readCrossChainOutbox(ethers, vault);
    expect(outboxAfterReset.exists).to.equal(true);
    expect(outboxAfterReset.message.messageType).to.equal(MessageType.TransferSent);
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
  });

  it("allows a side vault to directly initiate only a zero TransferSent", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { core, vault, adapter, router, assetManager, registrar } = fixture;
    const accountingChainId = 1n;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, accountingChainId, 8_001n);
    await core.connect(registrar).setCCIPSelector(destinationChainId, 7_001n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 0n]),
      );

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(destinationChainId);
    expect(outbox.nextState).to.equal(SessionState.Idle);
    expect(outbox.message.messageType).to.equal(MessageType.TransferSent);
    expect(outbox.message.amount).to.equal(0n);
  });

  it("keeps side non-zero transfers behind accounting approval", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { vault, adapter, router, assetManager } = fixture;
    const accountingChainId = 1n;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, accountingChainId, 8_001n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(accountingChainId);
    expect(outbox.nextState).to.equal(SessionState.ApprovalRequested);
    expect(outbox.message.messageType).to.equal(MessageType.TransferRequest);
    expect(outbox.message.amount).to.equal(100n);
  });

  it("sends side non-zero TransferSent only after accounting approval", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { core, vault, adapter, router, assetManager, registrar } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const accountingSelector = 8_001n;
    const destinationChainId = 42_161n;
    await configureCrossChain(fixture, accountingChainId, accountingSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, 7_001n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await router.setFailSend(true);
    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "approval-before-side-nonzero-transfer-sent",
      sourceChainSelector: accountingSelector,
      messageType: MessageType.TransferApproval,
      sourceChainId: localChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(destinationChainId);
    expect(outbox.nextState).to.equal(SessionState.Idle);
    expect(outbox.message.messageType).to.equal(MessageType.TransferSent);
    expect(outbox.message.amount).to.equal(100n);
  });

  it("allows destination side to receipt a zero TransferSent without delivered tokens", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { core, vault, router, registrar } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const sourceSideChainId = 42_161n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);
    await router.setFailSend(true);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "zero-transfer-sent-to-destination-side",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: sourceSideChainId,
        destinationChainId: localChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainTransferCompleted");

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(accountingChainId);
    expect(outbox.message.messageType).to.equal(MessageType.TransferReceipt);
    expect(outbox.message.sourceChainId).to.equal(sourceSideChainId);
    expect(outbox.message.destinationChainId).to.equal(localChainId);
    expect(outbox.message.sessionNonce).to.equal(1n);
    expect(outbox.message.amount).to.equal(0n);
  });

  it("rejects destination side non-zero TransferSent without delivered tokens", async function () {
    const fixture = await deployCrossChainFixture(1n);
    const { core, vault, router, registrar } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const sourceSideChainId = 42_161n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "nonzero-transfer-sent-without-tokens",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: sourceSideChainId,
        destinationChainId: localChainId,
        sessionNonce: 1n,
        amount: 100n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
  });

  it("allows a matching zero receipt to recover accounting AwaitingSatelliteCompletion", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const sourceSideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const sourceSelector = 7_001n;
    const destinationSelector = 7_002n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, destinationSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-request-before-zero-receipt",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "zero-receipt-recovers-accounting-awaiting",
        sourceChainSelector: destinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: sourceSideChainId,
        destinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainTransferCompleted");

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("allows a matching zero TransferSent to recover accounting AwaitingSatelliteCompletion", async function () {
    const fixture = await deployCrossChainFixture();
    const { vault, router } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceSideChainId = 42_161n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-to-accounting-request-before-zero-transfer-sent",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId: accountingChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "zero-transfer-sent-recovers-accounting-awaiting",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: sourceSideChainId,
        destinationChainId: accountingChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainTransferCompleted");

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("ignores zero TransferSent with a wrong source chain", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceSideChainId = 42_161n;
    const wrongSourceChainId = 42_162n;
    const sourceSelector = 7_001n;
    const wrongSourceSelector = 7_002n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(wrongSourceChainId, wrongSourceSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-to-accounting-request-before-wrong-source-zero-transfer-sent",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId: accountingChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "wrong-source-zero-transfer-sent",
        sourceChainSelector: wrongSourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: wrongSourceChainId,
        destinationChainId: accountingChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores stale zero TransferSent with a lower nonce", async function () {
    const fixture = await deployCrossChainFixture();
    const { asset, vault, router } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceSideChainId = 42_161n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "first-side-to-accounting-request-before-stale-zero-transfer-sent",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId: accountingChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "first-side-to-accounting-transfer-sent-before-stale-zero-transfer-sent",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferSent,
      sourceChainId: sourceSideChainId,
      destinationChainId: accountingChainId,
      sessionNonce: 1n,
      amount: 100n,
      destTokenAmounts: [{ token: await asset.getAddress(), amount: 100n }],
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "second-side-to-accounting-request-before-stale-zero-transfer-sent",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId: accountingChainId,
      sessionNonce: 2n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "lower-nonce-zero-transfer-sent",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: sourceSideChainId,
        destinationChainId: accountingChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores zero TransferSent while accounting is idle", async function () {
    const fixture = await deployCrossChainFixture();
    const { vault, router } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceSideChainId = 42_161n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "idle-accounting-zero-transfer-sent",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.TransferSent,
        sourceChainId: sourceSideChainId,
        destinationChainId: accountingChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("ignores stale zero receipt with a lower nonce", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const sourceSideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const sourceSelector = 7_001n;
    const destinationSelector = 7_002n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, destinationSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "first-side-request-before-stale-zero-receipt",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "first-side-receipt-before-stale-zero-receipt",
      sourceChainSelector: destinationSelector,
      messageType: MessageType.TransferReceipt,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "second-side-request-before-stale-zero-receipt",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 2n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "lower-nonce-zero-receipt",
        sourceChainSelector: destinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: sourceSideChainId,
        destinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores zero receipt with a wrong source chain", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const sourceSideChainId = 42_161n;
    const wrongSourceChainId = 42_162n;
    const destinationChainId = 84_531n;
    const sourceSelector = 7_001n;
    const destinationSelector = 7_002n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, destinationSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-request-before-wrong-source-zero-receipt",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "wrong-source-zero-receipt",
        sourceChainSelector: destinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: wrongSourceChainId,
        destinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores zero receipt with a wrong destination chain", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const sourceSideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const wrongDestinationChainId = 84_532n;
    const sourceSelector = 7_001n;
    const wrongDestinationSelector = 7_003n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);
    await core.connect(registrar).setCCIPSelector(destinationChainId, 7_002n);
    await core.connect(registrar).setCCIPSelector(wrongDestinationChainId, wrongDestinationSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-request-before-wrong-destination-zero-receipt",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "wrong-destination-zero-receipt",
        sourceChainSelector: wrongDestinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: sourceSideChainId,
        destinationChainId: wrongDestinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ignores zero receipt while accounting is idle", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, router, registrar } = fixture;
    const sourceSideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const destinationSelector = 7_002n;
    await configureCrossChain(fixture, sourceSideChainId, 7_001n);
    await core.connect(registrar).setCCIPSelector(destinationChainId, destinationSelector);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "idle-accounting-zero-receipt",
        sourceChainSelector: destinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: sourceSideChainId,
        destinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("ignores unrelated zero receipt while accounting transfer is dispatched", async function () {
    const fixture = await deployCrossChainFixture();
    const { core, vault, adapter, router, assetManager, registrar } = fixture;
    const accountingDestinationChainId = 42_161n;
    const sourceSideChainId = 42_162n;
    const receiptDestinationChainId = 84_531n;
    const accountingDestinationSelector = 7_001n;
    const receiptDestinationSelector = 7_002n;
    await configureCrossChain(fixture, accountingDestinationChainId, accountingDestinationSelector);
    await core.connect(registrar).setCCIPSelector(receiptDestinationChainId, receiptDestinationSelector);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [accountingDestinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "unrelated-zero-receipt-while-transfer-dispatched",
        sourceChainSelector: receiptDestinationSelector,
        messageType: MessageType.TransferReceipt,
        sourceChainId: sourceSideChainId,
        destinationChainId: receiptDestinationChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("keeps side-origin reset prohibited as a recovery path", async function () {
    const fixture = await deployCrossChainFixture();
    const { vault, router } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceSideChainId = 42_161n;
    const destinationChainId = 84_531n;
    const sourceSelector = 7_001n;
    await configureCrossChain(fixture, sourceSideChainId, sourceSelector);

    await deliverCrossChainMessage({
      router,
      vault,
      messageId: "side-request-before-prohibited-side-reset",
      sourceChainSelector: sourceSelector,
      messageType: MessageType.TransferRequest,
      sourceChainId: sourceSideChainId,
      destinationChainId,
      sessionNonce: 1n,
      amount: 100n,
    });
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);

    await expect(
      deliverCrossChainMessage({
        router,
        vault,
        messageId: "prohibited-side-reset",
        sourceChainSelector: sourceSelector,
        messageType: MessageType.Reset,
        sourceChainId: sourceSideChainId,
        destinationChainId: accountingChainId,
        sessionNonce: 1n,
        amount: 0n,
      }),
    ).to.emit(vault, "CrossChainMessageIgnored");

    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("keeps satellite finance paths unavailable through accounting-chain guards", async function () {
    const { vault, owner, settleManager } = await deployCrossChainFixture(1n);

    await expect(vault.connect(owner).requestDeposit(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(owner).cancelDeposit(owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
  });

  it("does not settle a queued custom-asset deposit after the value token is disabled", async function () {
    const { core, vault, escrow, customAsset, owner, settleManager } = await deployVaultFixture();
    const customAssetAddress = await customAsset.getAddress();
    const requestCustomDeposit = vault
      .connect(owner)
      .getFunction("requestDeposit(address,uint256,address,address,(bytes,uint64,uint8))");

    await requestCustomDeposit(customAssetAddress, 100n, owner.address, owner.address, {
      signature: "0x",
      validTill: 0n,
      tier: 0n,
    });
    await core.clearValueTokenConfig(customAssetAddress);
    await settleWithOracle(vault, settleManager, 100n);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.equal(0n);
    expect(await customAsset.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await escrow.balanceOf(await vault.getAddress(), customAssetAddress, owner.address)).to.deep.equal([
      100n,
      0n,
    ]);
  });

  it("clears temporary redeem settlement allowance after successful and failed escrow credits", async function () {
    const fixture = await deployVaultFixture();
    const { vault, asset, owner, settleManager } = fixture;
    const escrowAddress = await vault.escrow();
    await seedShares(fixture, owner, 100n);

    await vault.connect(owner).requestRedeem(40n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);
    expect(await asset.allowance(await vault.getAddress(), escrowAddress)).to.equal(0n);
    await vault.connect(owner).redeem(0n, owner.address, owner.address);

    await vault.connect(owner).requestRedeem(20n, owner.address, owner.address);
    await asset.setTransferFromRevertsOnce(true);
    await settleWithOracle(vault, settleManager, 60n);
    expect(await asset.allowance(await vault.getAddress(), escrowAddress)).to.equal(0n);
    expect(await vault.claimableRedeemRequest(0n, owner.address)).to.equal(0n);
    expect(await vault.balanceOf(owner.address)).to.equal(60n);
  });

  it("blocks escrow withdrawals while escrow operations are globally paused", async function () {
    const { core, vault, escrow, asset, owner, receiver } = await deployVaultFixture();
    const assetAddress = await asset.getAddress();
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await increaseTime(7n * 24n * 60n * 60n + 1n);
    await core.setGlobalPauseMask(1n << 10n);

    await expect(escrow.connect(owner).withdraw(await vault.getAddress(), assetAddress, 100n, receiver.address))
      .to.be.revertedWithCustomError(escrow, "Unauthorized")
      .withArgs(owner.address);
    expect(await escrow.balanceOf(await vault.getAddress(), assetAddress, owner.address)).to.deep.not.equal([0n, 0n]);
  });

  it("invalidates ERC-1271 signatures when signer permissions are removed after signing", async function () {
    const { vault, vaultOwner, assetManager, outsider } = await deployVaultFixture();
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [outsider.address, await vault.getAddress(), "0x"],
    );
    const digest = ethers.keccak256(ethers.toUtf8Bytes("MOCK_SIGNING_DIGEST"));
    const signer = ethers.Wallet.createRandom();
    const signature = signer.signingKey.sign(digest).serialized;

    await vault.connect(assetManager).signMessage(ethers.id("DAPP"), message);
    await vault.connect(vaultOwner).setPermissionMask(signer.address, MEMBER | VAULT_ASSET_MANAGER);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await vault.connect(vaultOwner).setPermissionMask(signer.address, 0n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
  });

  it("temporarily invalidates ERC-1271 signatures while an oracle request is active", async function () {
    const { core, vault, vaultOwner, oracle, owner, settleManager, assetManager, outsider } =
      await deployVaultFixture();
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [outsider.address, await vault.getAddress(), "0x"],
    );
    const digest = ethers.keccak256(ethers.toUtf8Bytes("MOCK_SIGNING_DIGEST"));
    const signer = ethers.Wallet.createRandom();
    const signature = signer.signingKey.sign(digest).serialized;

    await core.setNavRequestCooldown(1n);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(assetManager).signMessage(ethers.id("DAPP"), message);
    await vault.connect(vaultOwner).setPermissionMask(signer.address, MEMBER | VAULT_ASSET_MANAGER);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await vault.connect(settleManager).getFunction("settleRequests()")();
    expect(await vault.signedMessages(digest)).to.equal(true);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);

    await oracle.submitNav(await vault.activeOracleRequestId(), 100n, await nextBlockTimestamp());
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);
  });

  it("cools down oracle requests after ERC-1271 signMessage like adapter execution", async function () {
    const { core, vault, oracle, assetManager, owner, outsider, settleManager } = await deployVaultFixture();
    const cooldown = 60n;
    await core.setNavRequestCooldown(cooldown);
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);

    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes"],
      [outsider.address, await vault.getAddress(), "0x"],
    );
    const latest = await ethers.provider.getBlock("latest");
    const nextTimestamp = BigInt(latest!.timestamp + 10);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(nextTimestamp)]);

    await vault.connect(assetManager).signMessage(ethers.id("DAPP_COOLDOWN"), message);

    expect(await vault.settlementAllowedAt()).to.equal(nextTimestamp + cooldown);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);

    await increaseTime(cooldown);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.emit(vault, "OracleRequestStarted")
      .withArgs(await oracle.getAddress(), 1n);
  });

  it("does not allow stale signed requests after successful settlement and claim", async function () {
    const { vault, oracle, asset, owner, settleManager, vaultOwner } = await deployVaultFixture();
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const signedDeposit = await makeSignedRequest("deposit", vault, owner, {
      asset: await asset.getAddress(),
      amount: 100n,
      controller: owner.address,
      owner: owner.address,
      nonce: 0n,
      deadline,
    });
    await vault
      .connect(vaultOwner)
      .setPermissionMask(settleManager.address, MEMBER | VAULT_SETTLE_MANAGER | VAULT_CUSTOMER_MANAGER);
    const signedSettleRequests = vault
      .connect(settleManager)
      .getFunction(
        "settleRequests(((address,uint256,uint256,address,address),uint256,uint256,bytes)[],((address,uint256,uint256,address,address),uint256,uint256,bytes)[])",
      );

    await signedSettleRequests([signedDeposit], []);
    await oracle.submitNav(await vault.activeOracleRequestId(), 100n, await nextBlockTimestamp());
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    await advancePastSettlementCooldown(vault);
    await expect(signedSettleRequests([signedDeposit], []))
      .to.be.revertedWithCustomError(vault, "RequestStateError")
      .withArgs(RequestState.NoBatch);
    expect(await vault.requestNonces(owner.address)).to.equal(1n);
    expect(await vault.pendingDepositRequest(0n, owner.address)).to.equal(0n);
  });

  it("blocks performance-fee period bypass through repeated empty settlements", async function () {
    const fixture = await deployVaultFixture();
    const { vault, owner, settleManager, configManager } = fixture;
    const maxThreshold = 65_535n;
    const performanceFeeSchedule = 1_000n | (maxThreshold << 16n) | (3600n << 128n);
    await vault.connect(configManager).setFees(0n, performanceFeeSchedule);
    await seedShares(fixture, owner, 100n);

    await expect(vault.connect(settleManager).getFunction("settleRequests()")()).to.be.revertedWithCustomError(
      vault,
      "OracleFlowError",
    );

    await increaseTime(3600n);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")()).to.emit(vault, "OracleRequestStarted");
  });
});
