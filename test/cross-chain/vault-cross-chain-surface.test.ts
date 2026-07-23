import { expect } from "chai";
import { readFile } from "node:fs/promises";
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
  NotConfigured: 1n,
  AccountingChainOnly: 2n,
};
const OracleFlow = { Active: 3n, Cooldown: 6n };
const SettlementAction = {
  None: 0n,
  Unlock: 1n,
  Cooldown: 2n,
  Lock: 3n,
};

async function deployFixture(accountingChainId?: bigint) {
  const [authority, registrar, curatorOwner, vaultOwner, owner, assetManager, settleManager, outsider] =
    await ethers.getSigners();
  const { core, escrowProxy } = await deployConfiguredCore(ethers, authority, { accountingChainId });
  const escrow = await ethers.getContractAt("UFarmEscrow", await escrowProxy.getAddress());
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const executeAdapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("execute-adapter")]);
  const receiveAdapter = await ethers.deployContract("MockVaultCrossChainReceiveAdapter");

  await core.setPermissionMask(
    registrar.address,
    (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_CONFIG_MANAGER | CORE_ADAPTER_MANAGER,
  );
  await configureValueToken(ethers, core, asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("cross-chain-curator"));
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
      ethers.id("cross-chain-vault"),
      vaultOwner.address,
      "UFarm Cross-Chain Vault",
      "uXCC",
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
  await asset.mint(owner.address, 1_000_000n);
  await asset.connect(owner).approve(await escrow.getAddress(), 1_000_000n);

  return { core, vault, asset, owner, assetManager, settleManager, outsider, executeAdapter, receiveAdapter };
}

async function setFutureSettlement(vault: any, core: any, assetManager: any, adapter: any, secondsAhead: bigint) {
  const adapterId = ethers.id("settlement-forward");
  await core.setVaultAdapter(adapterId, ethers.ZeroAddress, await adapter.getAddress());
  await core.setNavRequestCooldown(secondsAhead);
  const data = adapter.interface.encodeFunctionData("echoUint256", [SettlementAction.Cooldown]);
  const tx = await vault.connect(assetManager).executeAdapter(adapterId, data);
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  const target = BigInt(block!.timestamp) + secondsAhead;
  return target;
}

async function advancePastSettlementLock(vault: any) {
  const allowedAt = await vault.settlementAllowedAt();
  const latest = await ethers.provider.getBlock("latest");
  if (allowedAt > BigInt(latest!.timestamp)) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(allowedAt)]);
    await ethers.provider.send("evm_mine", []);
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
  await vault.connect(signer).getFunction("settleRequests()")();
  const requestId = await vault.activeOracleRequestId();
  const latest = await ethers.provider.getBlock("latest");
  return oracle.submitNav(requestId, nav, BigInt(latest!.timestamp + 1));
}

describe("UFarmVault cross-chain surface", function () {
  it("exposes exact cross-chain event ABI shapes", async function () {
    const eventsFile = await readFile("contracts/vault/UFarmVaultEvents.sol", "utf8");
    const fragments = eventsFile.match(/event\s+CrossChain[^{;]+;/g)?.map((event) => event.replace(/;$/, "")) ?? [];
    const iface = new ethers.Interface(fragments);

    const expectations = [
      {
        name: "CrossChainTransferStarted",
        names: ["sourceChainId", "destinationChainId", "amount", "nonce"],
        types: ["uint64", "uint64", "uint256", "uint64"],
        indexed: [true, true, false, false],
      },
      {
        name: "CrossChainTransferCompleted",
        names: ["sourceChainId", "destinationChainId", "amount", "nonce"],
        types: ["uint64", "uint64", "uint256", "uint64"],
        indexed: [true, true, false, false],
      },
      {
        name: "CrossChainOutboxQueued",
        names: ["targetChainId", "messageType", "nonce"],
        types: ["uint64", "uint8", "uint64"],
        indexed: [true, true, true],
      },
      {
        name: "CrossChainDispatchSucceeded",
        names: ["targetChainId", "messageId", "nonce"],
        types: ["uint64", "bytes32", "uint64"],
        indexed: [true, true, true],
      },
      {
        name: "CrossChainDispatchFailed",
        names: ["targetChainId", "messageType", "nonce"],
        types: ["uint64", "uint8", "uint64"],
        indexed: [true, true, true],
      },
      {
        name: "CrossChainMessageIgnored",
        names: ["sourceChainId", "messageType", "reason"],
        types: ["uint64", "uint8", "uint8"],
        indexed: [true, true, true],
      },
      {
        name: "CrossChainSessionReset",
        names: ["targetChainId", "nonce"],
        types: ["uint64", "uint64"],
        indexed: [true, true],
      },
    ];

    for (const eventSpec of expectations) {
      const fragment = iface.getEvent(eventSpec.name);
      expect(fragment).to.not.equal(null);
      expect(fragment.inputs.map((input) => input.name)).to.deep.equal(eventSpec.names);
      expect(fragment.inputs.map((input) => input.type)).to.deep.equal(eventSpec.types);
      expect(fragment.inputs.map((input) => Boolean(input.indexed))).to.deep.equal(eventSpec.indexed);
    }
  });

  it("exposes cross-chain surface defaults", async function () {
    const { vault } = await deployFixture();

    expect(CROSS_CHAIN_ADAPTER_ID).to.equal(ethers.id("ufarm.adapter.cross-chain"));
    expect(await vault.crossChainState()).to.deep.equal([0n, false]);
    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(false);
    expect(outbox.targetChainId).to.equal(0n);
  });

  it("rejects finance and claim paths on non-accounting chain", async function () {
    const { vault, owner } = await deployFixture(1n);

    await expect(vault.connect(owner).requestDeposit(1n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(owner).deposit(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
    await expect(vault.connect(owner).redeem(0n, owner.address, owner.address))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
  });

  it("allows accounting-chain requests but rejects settlement while settlement cooldown is active", async function () {
    const { vault, core, owner, assetManager, settleManager, executeAdapter } = await deployFixture();
    await vault.connect(owner).requestDeposit(10n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 10n);
    await vault.connect(owner).deposit(0n, owner.address, owner.address);

    await setFutureSettlement(vault, core, assetManager, executeAdapter, 3600n);

    await vault.connect(owner).requestDeposit(1n, owner.address, owner.address);
    await vault.connect(owner).cancelDeposit(owner.address);
    await vault.connect(owner).requestRedeem(1n, owner.address, owner.address);
    await vault.connect(owner).cancelRedeem(owner.address);

    await expect(vault.connect(settleManager).getFunction("settleRequests()")())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
    await expect(settleWithOracle(vault, settleManager, 100n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
    await expect(vault.connect(settleManager).resetRequests())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
    await expect(vault.connect(settleManager).manualResendOracleRequest())
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
  });

  it("allows deposit and redeem claims while settlement cooldown is active", async function () {
    const { vault, core, asset, owner, outsider, assetManager, settleManager, executeAdapter } = await deployFixture();
    const [, , , , , , , , redeemToOwner] = await ethers.getSigners();

    await asset.mint(outsider.address, 1_000_000n);
    await asset.connect(outsider).approve(await vault.escrow(), 1_000_000n);
    await asset.mint(redeemToOwner.address, 1_000_000n);
    await asset.connect(redeemToOwner).approve(await vault.escrow(), 1_000_000n);

    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await settleWithOracle(vault, settleManager, 100n);

    await advancePastSettlementLock(vault);
    await vault.connect(outsider).requestDeposit(200n, outsider.address, outsider.address);
    await settleWithOracle(vault, settleManager, 300n);
    await vault.connect(outsider).deposit(0n, outsider.address, outsider.address);

    await advancePastSettlementLock(vault);
    const outsiderShares = await vault.balanceOf(outsider.address);
    await vault.connect(outsider).requestRedeem(outsiderShares, outsider.address, outsider.address);
    await settleWithOracle(vault, settleManager, 300n);

    await advancePastSettlementLock(vault);
    await vault.connect(redeemToOwner).requestDeposit(150n, redeemToOwner.address, redeemToOwner.address);
    await settleWithOracle(vault, settleManager, 450n);
    await vault.connect(redeemToOwner).deposit(0n, redeemToOwner.address, redeemToOwner.address);

    await advancePastSettlementLock(vault);
    const redeemToOwnerShares = await vault.balanceOf(redeemToOwner.address);
    await vault.connect(redeemToOwner).requestRedeem(redeemToOwnerShares, redeemToOwner.address, redeemToOwner.address);
    await settleWithOracle(vault, settleManager, 450n);

    expect(await vault.claimableDepositRequest(0n, owner.address)).to.be.gt(0n);
    expect(await vault.claimableRedeemRequest(0n, outsider.address)).to.be.gt(0n);
    expect(await vault.claimableRedeemRequest(0n, redeemToOwner.address)).to.be.gt(0n);

    await setFutureSettlement(vault, core, assetManager, executeAdapter, 3600n);

    await vault.connect(owner).deposit(0n, owner.address, owner.address);
    await vault.connect(outsider).redeem(0n, outsider.address, outsider.address);
    await vault.connect(redeemToOwner).redeem(0n, owner.address, redeemToOwner.address);
  });

  it("rejects onOracleNav while settlement cooldown is active", async function () {
    const { vault, core, outsider, assetManager, executeAdapter } = await deployFixture();
    await setFutureSettlement(vault, core, assetManager, executeAdapter, 3600n);
    await expect(vault.connect(outsider).onOracleNav(1n, 10n, 1n))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Cooldown);
  });

  it("ccipReceive rejects unset router as not configured", async function () {
    const { vault, outsider } = await deployFixture();
    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("router-unset")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message))
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);
  });

  it("ccipReceive rejects non-router callers", async function () {
    const { core, vault, owner, outsider } = await deployFixture();
    await core.setCrossChainRouter(owner.address);
    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("m1")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(outsider.address);
  });

  it("ccipReceive rejects missing adapter for configured router", async function () {
    const { core, vault, outsider } = await deployFixture();
    await core.setCrossChainRouter(outsider.address);

    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("m2")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message)).to.be.revertedWithCustomError(vault, "InvalidAdapter");
  });

  it("ccipReceive delegatecalls adapter and applies returned lock action", async function () {
    const { core, vault, outsider, receiveAdapter } = await deployFixture();
    await core.setCrossChainRouter(outsider.address);
    await core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, await vault.getAddress(), await receiveAdapter.getAddress());

    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("m3")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [SettlementAction.Lock]),
      destTokenAmounts: [],
    };

    expect(await vault.settlementAllowedAt()).to.equal(0n);
    await vault.connect(outsider).ccipReceive(message);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("ccipReceive keeps settlementAllowedAt unchanged when adapter returns none", async function () {
    const { core, vault, outsider, receiveAdapter, assetManager, executeAdapter } = await deployFixture();
    await core.setCrossChainRouter(outsider.address);
    await core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, await vault.getAddress(), await receiveAdapter.getAddress());

    const before = await setFutureSettlement(vault, core, assetManager, executeAdapter, 1200n);
    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("m4")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await vault.connect(outsider).ccipReceive(message);
    expect(await vault.settlementAllowedAt()).to.equal(before);
  });

  it("ccipReceive bubbles adapter delegatecall revert data", async function () {
    const { core, vault, outsider, receiveAdapter } = await deployFixture();
    await core.setCrossChainRouter(outsider.address);
    await core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, await vault.getAddress(), await receiveAdapter.getAddress());

    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("m5")),
      sourceChainSelector: 999n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: "0x",
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message))
      .to.be.revertedWithCustomError(receiveAdapter, "MockCCIPReceiveFailed")
      .withArgs(999n);
  });

  it("ccipReceive rejects while an oracle request is active before adapter delegatecall", async function () {
    const { core, vault, owner, outsider, settleManager, receiveAdapter } = await deployFixture();
    const oracle = await ethers.deployContract("MockUFarmOracle");
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());
    await vault.connect(owner).requestDeposit(100n, owner.address, owner.address);
    await vault.connect(settleManager).getFunction("settleRequests()")();

    await core.setCrossChainRouter(outsider.address);
    await core.setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, await vault.getAddress(), await receiveAdapter.getAddress());
    const latest = await ethers.provider.getBlock("latest");
    const message = {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("active-oracle")),
      sourceChainSelector: 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [outsider.address]),
      data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(latest!.timestamp) + 1800n]),
      destTokenAmounts: [],
    };

    await expect(vault.connect(outsider).ccipReceive(message))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
    expect(await vault.settlementAllowedAt()).to.equal(0n);
  });
});
