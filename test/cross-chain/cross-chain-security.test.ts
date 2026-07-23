import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { CROSS_CHAIN_ADAPTER_ID, readCrossChainOutbox } from "./helpers";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const CORE_CURATOR_REGISTRAR = 1n << 0n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const CORE_ADAPTER_MANAGER = 1n << 3n;
const VAULT_ASSET_MANAGER = 1n << 0n;
const VAULT_SETTLE_MANAGER = 1n << 1n;

const CrossChainFlow = {
  AccountingChainOnly: 2n,
};

const OracleFlow = {
  Active: 3n,
  Cooldown: 6n,
};

const MessageType = {
  TransferRequest: 0n,
  TransferSent: 2n,
  TransferReceipt: 3n,
};

async function deployFixture(accountingChainId?: bigint) {
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
    (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_CONFIG_MANAGER | CORE_ADAPTER_MANAGER,
  );
  await configureValueToken(ethers, core, asset);
  await configureValueToken(ethers, core, feeToken);

  const curatorTx = await core
    .connect(registrar)
    .createCurator(curatorOwner.address, ethers.id("cross-chain-security-curator"));
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
      ethers.id("cross-chain-security-vault"),
      vaultOwner.address,
      "UFarm Cross-Chain Security Vault",
      "uXSEC",
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
  await core.connect(registrar).setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());

  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);
  await feeToken.mint(await vault.getAddress(), 1_000_000n);

  return { core, vault, router, feeToken, asset, adapter, owner, assetManager, settleManager, outsider, registrar };
}

async function configureDispatch(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  destinationChainId: bigint,
  selector = 4_949_039_107_694_359_620n,
) {
  const { core, registrar, router, feeToken, asset } = fixture;
  await core.connect(registrar).setCCIPSelector(destinationChainId, selector);
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
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const latest = await ethers.provider.getBlock("latest");
  return oracle.submitNav(requestId, nav, BigInt(latest!.timestamp + 1));
}

describe("Cross-chain security integration regressions", function () {
  it("allows request/cancel but blocks settlement while cross-chain lock is MaxUint256", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, router, assetManager, settleManager, owner } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);
    await vault.connect(owner).cancelDeposit(owner.address);

    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
  });

  it("keeps claims and new requests callable on accounting chain during cross-chain lock while settlement stays blocked", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, router, owner, assetManager, settleManager } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 50n]),
      );
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(owner).requestRedeem(1n, owner.address, owner.address);
    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
  });

  it("rejects satellite request/cancel/claim/settlement finance paths via accounting-chain guard", async function () {
    const fixture = await deployFixture(1n);
    const { vault, owner, settleManager } = fixture;

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

  it("keeps ccipReceive router-only guard and relies on existing adapter callback reentrancy coverage", async function () {
    const fixture = await deployFixture();
    const { vault, outsider } = fixture;
    const message = {
      messageId: ethers.ZeroHash,
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message)).to.be.revertedWithCustomError(
      vault,
      "CrossChainFlowError",
    );
  });

  it("rejects inbound TransferRequest while an oracle request is active", async function () {
    const fixture = await deployFixture();
    const { core, vault, router, owner, settleManager } = fixture;
    const sourceChainId = 10n;
    const sourceSelector = 4_001n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const oracle = await ethers.deployContract("MockUFarmOracle");
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(settleManager).getFunction("settleRequests()")();

    await configureDispatch(fixture, sourceChainId, sourceSelector);
    await router.setFee(1n);

    await expect(
      router.deliver(await vault.getAddress(), {
        messageId: ethers.keccak256(ethers.toUtf8Bytes("request-during-oracle")),
        sourceChainSelector: sourceSelector,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
        data: encodeCrossChainMessage(MessageType.TransferRequest, sourceChainId, localChainId, 1n, 50n),
        destTokenAmounts: [],
      }),
    )
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);

    expect((await vault.crossChainState()).state).to.equal(0n);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("ignores invalid inbound CCIP messages without unlocking existing MaxUint lock", async function () {
    const fixture = await deployFixture();
    const { core, vault, adapter, router, asset, owner, assetManager } = fixture;
    const destinationChainId = 42_161n;
    const selector = 4_949_039_107_694_359_620n;
    await configureDispatch(fixture, destinationChainId, selector);
    await core.setCCIPSelector(31337n, 16_068_617_062_157_068_43n);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const badSenderMessage = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-sender")),
      sourceChainSelector: selector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [owner.address]),
      data: encodeCrossChainMessage(MessageType.TransferSent, localChainId, destinationChainId, 1n, 100n),
      destTokenAmounts: [{ token: await asset.getAddress(), amount: 100n }],
    };

    await router.deliver(await vault.getAddress(), badSenderMessage);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("manual resend recovers failed dispatch and finite unlock permits settlement after cooldown", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, router, owner, assetManager, settleManager } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);
    await expect(settleWithOracle(vault, settleManager, 101n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);

    await router.setFailSend(false);
    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    const localChainId = (await ethers.provider.getNetwork()).chainId;
    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("receipt-after-resend")),
      sourceChainSelector: 4_949_039_107_694_359_620n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferReceipt, localChainId, destinationChainId, 1n, 100n),
      destTokenAmounts: [],
    });

    const unlockedAt = await vault.settlementAllowedAt();
    expect(unlockedAt).to.not.equal(ethers.MaxUint256);

    const latest = await ethers.provider.getBlock("latest");
    if (unlockedAt > BigInt(latest!.timestamp)) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(unlockedAt)]);
      await ethers.provider.send("evm_mine", []);
    }

    await settleWithOracle(vault, settleManager, 101n);
  });
});
