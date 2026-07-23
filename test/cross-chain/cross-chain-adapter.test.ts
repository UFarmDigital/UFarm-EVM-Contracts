import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { CROSS_CHAIN_ADAPTER_ID, readCrossChainOutbox } from "./helpers";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const CORE_CURATOR_REGISTRAR = 1n << 0n;
const CORE_CONFIG_MANAGER = 1n << 1n;
const CORE_ADAPTER_MANAGER = 1n << 3n;
const CORE_CROSSCHAIN_GUARD_MANAGER = 1n << 8n;
const VAULT_ASSET_MANAGER = 1n << 0n;
const CROSS_CHAIN_OPERATIONS_PAUSED = 1n << 8n;

const CrossChainFlow = {
  NotConfigured: 1n,
  AccountingChainOnly: 2n,
  Active: 4n,
  NoOutbox: 5n,
  InvalidChain: 6n,
  InvalidSelector: 7n,
};

const SessionState = {
  Idle: 0n,
  ApprovalRequested: 1n,
  TransferDispatched: 2n,
  AwaitingSatelliteCompletion: 3n,
};

const MessageType = {
  TransferRequest: 0n,
  TransferApproval: 1n,
  TransferSent: 2n,
  TransferReceipt: 3n,
  Reset: 4n,
};
const crossChainEventInterface = new ethers.Interface([
  "event CrossChainTransferStarted(uint64 indexed sourceChainId, uint64 indexed destinationChainId, uint256 amount, uint64 nonce)",
  "event CrossChainOutboxQueued(uint64 indexed targetChainId, uint8 indexed messageType, uint64 indexed nonce)",
  "event CrossChainDispatchSucceeded(uint64 indexed targetChainId, bytes32 indexed messageId, uint64 indexed nonce)",
  "event CrossChainDispatchFailed(uint64 indexed targetChainId, uint8 indexed messageType, uint64 indexed nonce)",
  "event CrossChainTransferCompleted(uint64 indexed sourceChainId, uint64 indexed destinationChainId, uint256 amount, uint64 nonce)",
  "event CrossChainMessageIgnored(uint64 indexed sourceChainId, uint8 indexed messageType, uint8 indexed reason)",
  "event CrossChainSessionReset(uint64 indexed targetChainId, uint64 indexed nonce)",
]);

async function deployFixture(
  optionsOrAccountingChainId?: bigint | { accountingChainId?: bigint; initializeCrossChain?: boolean },
) {
  const [authority, registrar, curatorOwner, vaultOwner, assetManager] = await ethers.getSigners();
  const options =
    typeof optionsOrAccountingChainId === "bigint"
      ? { accountingChainId: optionsOrAccountingChainId }
      : optionsOrAccountingChainId;
  const { core } = await deployConfiguredCore(ethers, authority, options);
  const router = await ethers.deployContract("MockCCIPRouter");
  const feeToken = await ethers.deployContract("MockERC20", ["Fee Token", "FEE", 18]);
  const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
  const adapter = await ethers.deployContract("CrossChainAdapter");

  await core.setPermissionMask(
    registrar.address,
    (1n << 253n) | CORE_CURATOR_REGISTRAR | CORE_CONFIG_MANAGER | CORE_ADAPTER_MANAGER,
  );
  await configureValueToken(ethers, core.connect(registrar), asset);

  const curatorTx = await core.connect(registrar).createCurator(curatorOwner.address, ethers.id("cc-adapter-curator"));
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
      ethers.id("cc-adapter-vault"),
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
  await core.connect(registrar).setVaultAdapter(CROSS_CHAIN_ADAPTER_ID, ethers.ZeroAddress, await adapter.getAddress());
  await feeToken.mint(await vault.getAddress(), 1_000_000n);

  return { authority, registrar, curator, core, router, feeToken, asset, adapter, vault, assetManager };
}

async function expectIdleWithNoOutbox(vault: any, router?: any) {
  expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
  expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  if (router) {
    expect(await router.lastDestinationSelector()).to.equal(0n);
  }
}

function decodeRouterPayload(raw: string) {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const [version, messageType, sourceChainId, destinationChainId, sessionNonce, amount] = abi.decode(
    ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
    raw,
  );
  return { version, messageType, sourceChainId, destinationChainId, sessionNonce, amount };
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

async function findEventArgs(tx: any, eventName: string, emitterAddress: string) {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== emitterAddress.toLowerCase()) continue;
    try {
      const parsed = crossChainEventInterface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed.args;
      }
    } catch {}
  }
  throw new Error(`Event ${eventName} not found`);
}

async function configureDispatch(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  destinationChainId: bigint,
  selector = 4_949_039_107_694_359_620n,
  crossChainToken?: string,
) {
  const { core, router, feeToken, asset, registrar } = fixture;
  await core.connect(registrar).setCCIPSelector(destinationChainId, selector);
  await core.connect(registrar).setCrossChainRouter(await router.getAddress());
  await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
  await core.connect(registrar).setCrossChainToken(crossChainToken ?? (await asset.getAddress()));
  await core.connect(registrar).setCrossChainGasLimit(500_000n);
}

async function grantCrossChainGuard(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const { core, authority, assetManager } = fixture;
  await core.connect(authority).setPermissionMask(assetManager.address, (1n << 253n) | CORE_CROSSCHAIN_GUARD_MANAGER);
}

describe("CrossChainAdapter outbound sessions", function () {
  it("rejects direct external calls with delegatecall-only error", async function () {
    const { adapter } = await deployFixture();

    await expect(adapter.crossChainTransfer(42n, 1n)).to.be.revertedWithCustomError(
      adapter,
      "CrossChainAdapterDelegateCallOnly",
    );
    await expect(
      adapter.onCCIPReceive({
        messageId: ethers.ZeroHash,
        sourceChainSelector: 0n,
        sender: "0x",
        data: "0x",
        destTokenAmounts: [],
      }),
    ).to.be.revertedWithCustomError(adapter, "CrossChainAdapterDelegateCallOnly");
    await expect(adapter.manualResendCrossChainMessage()).to.be.revertedWithCustomError(
      adapter,
      "CrossChainAdapterDelegateCallOnly",
    );
    await expect(adapter.manualResetCrossChainSession(1n)).to.be.revertedWithCustomError(
      adapter,
      "CrossChainAdapterDelegateCallOnly",
    );
    await expect(adapter.emergencyResetCrossChainSession()).to.be.revertedWithCustomError(
      adapter,
      "CrossChainAdapterDelegateCallOnly",
    );
  });

  it("rejects cross-chain adapter entrypoints before accounting chain is configured", async function () {
    const { vault, adapter, assetManager } = await deployFixture({ initializeCrossChain: false });

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [42_161n, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("emergencyResetCrossChainSession"),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage")),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("manualResetCrossChainSession", [42_161n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);
  });

  it("dispatches accounting->satellite transfer and clears outbox on success", async function () {
    const fixture = await deployFixture();
    const { core, vault, router, feeToken, asset, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(777n);

    const amount = 12_345n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const messageId = ethers.toBeHex(1n, 32);
    const tx = await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
      );
    const transferStarted = await findEventArgs(tx, "CrossChainTransferStarted", await vault.getAddress());
    expect(transferStarted.sourceChainId).to.equal(localChainId);
    expect(transferStarted.destinationChainId).to.equal(destinationChainId);
    expect(transferStarted.amount).to.equal(amount);
    expect(transferStarted.nonce).to.equal(1n);
    const outboxQueued = await findEventArgs(tx, "CrossChainOutboxQueued", await vault.getAddress());
    expect(outboxQueued.targetChainId).to.equal(destinationChainId);
    expect(outboxQueued.messageType).to.equal(MessageType.TransferSent);
    expect(outboxQueued.nonce).to.equal(1n);
    const dispatched = await findEventArgs(tx, "CrossChainDispatchSucceeded", await vault.getAddress());
    expect(dispatched.targetChainId).to.equal(destinationChainId);
    expect(dispatched.messageId).to.equal(messageId);
    expect(dispatched.nonce).to.equal(1n);

    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([await asset.getAddress(), amount]);
    expect(await router.lastReceiver()).to.equal(
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
    );
    expect(await router.lastFeeToken()).to.equal(await feeToken.getAddress());
    expect(await router.lastExtraArgs()).to.equal(
      ethers.concat(["0x97a657c9", ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [500_000n])]),
    );
    expect(await router.lastDestinationSelector()).to.equal(await core.ccipSelectorForChain(destinationChainId));

    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.version).to.equal(1n);
    expect(payload.messageType).to.equal(MessageType.TransferSent);
    expect(payload.sourceChainId).to.equal(localChainId);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.sessionNonce).to.equal(1n);
    expect(payload.amount).to.equal(amount);
  });

  it("uses core crossChainToken instead of vault asset for outbound token transfers", async function () {
    const fixture = await deployFixture();
    const { core, vault, router, adapter, assetManager, registrar } = fixture;
    const destinationChainId = 42_161n;
    const crossChainToken = await ethers.deployContract("MockERC20", ["CCIP USDC", "ccUSDC", 18]);
    await configureDispatch(
      fixture,
      destinationChainId,
      4_949_039_107_694_359_620n,
      await crossChainToken.getAddress(),
    );

    const amount = 12_345n;
    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
      );

    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([await crossChainToken.getAddress(), amount]);
  });

  it("dispatches satellite-origin request to accounting chain with empty tokenAmounts", async function () {
    const fixture = await deployFixture(1n);
    const { vault, router, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    const accountingChainId = 1n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const amount = 50n;

    await configureDispatch(fixture, accountingChainId, 1_606_861_706_215_706_843n);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
      );

    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
    expect(await router.lastTokenAmountCount()).to.equal(0n);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.version).to.equal(1n);
    expect(payload.messageType).to.equal(MessageType.TransferRequest);
    expect(payload.sourceChainId).to.equal(localChainId);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.sessionNonce).to.equal(1n);
    expect(payload.amount).to.equal(amount);
  });

  it("dispatches satellite zero transfer directly and unlocks the local session", async function () {
    const fixture = await deployFixture(1n);
    const { vault, router, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    await configureDispatch(fixture, destinationChainId, 4_949_039_107_694_359_620n);
    await router.setFee(1n);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 0n]),
      );

    const started = await findEventArgs(tx, "CrossChainTransferStarted", await vault.getAddress());
    expect(started.sourceChainId).to.equal(localChainId);
    expect(started.destinationChainId).to.equal(destinationChainId);
    expect(started.amount).to.equal(0n);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
    expect(await router.lastTokenAmountCount()).to.equal(0n);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.TransferSent);
    expect(payload.sourceChainId).to.equal(localChainId);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.amount).to.equal(0n);
  });

  it("manualResend retries a failed satellite zero transfer without a token payload", async function () {
    const fixture = await deployFixture(1n);
    const { vault, router, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId, 4_949_039_107_694_359_620n);
    await router.setFee(1n);
    await router.setFailSend(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 0n]),
      );

    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(true);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await router.setFailSend(false);
    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    expect(await router.lastTokenAmountCount()).to.equal(0n);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.TransferSent);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.amount).to.equal(0n);
  });

  it("keeps outbox when router getFee fails", async function () {
    const fixture = await deployFixture();
    const { vault, router, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const amount = 100n;
    const nonce = 1n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFailGetFee(true);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
      );
    const transferStarted = await findEventArgs(tx, "CrossChainTransferStarted", await vault.getAddress());
    expect(transferStarted.sourceChainId).to.equal(localChainId);
    expect(transferStarted.destinationChainId).to.equal(destinationChainId);
    expect(transferStarted.amount).to.equal(amount);
    expect(transferStarted.nonce).to.equal(nonce);
    const outboxQueued = await findEventArgs(tx, "CrossChainOutboxQueued", await vault.getAddress());
    expect(outboxQueued.targetChainId).to.equal(destinationChainId);
    expect(outboxQueued.messageType).to.equal(MessageType.TransferSent);
    expect(outboxQueued.nonce).to.equal(nonce);
    const failed = await findEventArgs(tx, "CrossChainDispatchFailed", await vault.getAddress());
    expect(failed.targetChainId).to.equal(destinationChainId);
    expect(failed.messageType).to.equal(MessageType.TransferSent);
    expect(failed.nonce).to.equal(nonce);

    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
  });

  it("keeps outbox when router ccipSend fails", async function () {
    const fixture = await deployFixture();
    const { vault, router, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const amount = 100n;
    const nonce = 1n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);
    await router.setFailSend(true);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
      );
    const transferStarted = await findEventArgs(tx, "CrossChainTransferStarted", await vault.getAddress());
    expect(transferStarted.sourceChainId).to.equal(localChainId);
    expect(transferStarted.destinationChainId).to.equal(destinationChainId);
    expect(transferStarted.amount).to.equal(amount);
    expect(transferStarted.nonce).to.equal(nonce);
    const outboxQueued = await findEventArgs(tx, "CrossChainOutboxQueued", await vault.getAddress());
    expect(outboxQueued.targetChainId).to.equal(destinationChainId);
    expect(outboxQueued.messageType).to.equal(MessageType.TransferSent);
    expect(outboxQueued.nonce).to.equal(nonce);
    const failed = await findEventArgs(tx, "CrossChainDispatchFailed", await vault.getAddress());
    expect(failed.targetChainId).to.equal(destinationChainId);
    expect(failed.messageType).to.equal(MessageType.TransferSent);
    expect(failed.nonce).to.equal(nonce);

    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
  });

  it("validates amount, destination chain, token config, and active session", async function () {
    const fixture = await deployFixture();
    const { core, vault, adapter, assetManager, registrar, asset } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 0n]),
        ),
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("crossChainTransfer", [0n, 1n])),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.InvalidChain);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [31337n, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.InvalidChain);

    await core.connect(registrar).setCrossChainToken(ethers.ZeroAddress);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    ).to.be.revertedWithCustomError(vault, "InvalidAsset");
    await expectIdleWithNoOutbox(vault, fixture.router);
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());

    await core.connect(registrar).setCCIPSelector(destinationChainId, 0n);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.InvalidSelector);
    await expectIdleWithNoOutbox(vault, fixture.router);

    await core.connect(registrar).setCCIPSelector(destinationChainId, 1n);
    await core.connect(registrar).setCrossChainRouter(ethers.ZeroAddress);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);
    await expectIdleWithNoOutbox(vault, fixture.router);

    await core.connect(registrar).setCrossChainRouter(await fixture.router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(ethers.ZeroAddress);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);
    await expectIdleWithNoOutbox(vault, fixture.router);

    await core.connect(registrar).setCrossChainFeeToken(await fixture.feeToken.getAddress());
    const emptyConfigFixture = await deployFixture();
    await emptyConfigFixture.core.connect(emptyConfigFixture.registrar).setCCIPSelector(destinationChainId, 1n);
    await emptyConfigFixture.core
      .connect(emptyConfigFixture.registrar)
      .setCrossChainRouter(await emptyConfigFixture.router.getAddress());
    await emptyConfigFixture.core
      .connect(emptyConfigFixture.registrar)
      .setCrossChainFeeToken(await emptyConfigFixture.feeToken.getAddress());
    await emptyConfigFixture.core
      .connect(emptyConfigFixture.registrar)
      .setCrossChainToken(await emptyConfigFixture.asset.getAddress());
    await expect(
      emptyConfigFixture.vault
        .connect(emptyConfigFixture.assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          emptyConfigFixture.adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    )
      .to.be.revertedWithCustomError(emptyConfigFixture.vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NotConfigured);
    await expectIdleWithNoOutbox(emptyConfigFixture.vault, emptyConfigFixture.router);

    await fixture.router.setFailGetFee(true);
    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 50n]),
      );
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 50n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.Active);
  });

  it("reverts when cross-chain is paused by global or curator pause masks", async function () {
    const fixture = await deployFixture();
    const { core, curator, vault, adapter, assetManager, authority } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);

    await core.connect(authority).setGlobalPauseMask(CROSS_CHAIN_OPERATIONS_PAUSED);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    ).to.be.revertedWithCustomError(vault, "FlowPaused");

    await core.connect(authority).setGlobalPauseMask(0n);
    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n);
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 1n]),
        ),
    ).to.be.revertedWithCustomError(vault, "FlowPaused");
  });
});

describe("CrossChainAdapter inbound sessions", function () {
  it("manualResend reverts with CROSS_CHAIN_NO_OUTBOX when no outbox exists", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager } = fixture;
    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage")),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.NoOutbox);
  });

  it("manualResend preserves outbox when repeated dispatch keeps failing", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await grantCrossChainGuard(fixture);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    const firstOutbox = await readCrossChainOutbox(ethers, vault);
    expect(firstOutbox.exists).to.equal(true);

    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    const secondOutbox = await readCrossChainOutbox(ethers, vault);
    expect(secondOutbox.exists).to.equal(true);
    expect(secondOutbox.targetChainId).to.equal(destinationChainId);
    expect(secondOutbox.message.messageType).to.equal(MessageType.TransferSent);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("manualResend succeeds for failed final TransferSent and clears outbox/session lock", async function () {
    const fixture = await deployFixture(1n);
    const { core, router, vault, registrar, feeToken, adapter, asset, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const sourceChainId = localChainId;
    await core.connect(registrar).setCCIPSelector(sourceChainId, 4_001n);
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);
    await core.connect(registrar).setCCIPSelector(42_161n, 9_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFee(1n);
    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [42_161n, 777n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
    await router.setFailGetFee(true);

    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("approval-fail")),
      sourceChainSelector: 8_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferApproval, sourceChainId, 42_161n, 1n, 777n),
      destTokenAmounts: [],
    });

    let outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.message.messageType).to.equal(MessageType.TransferSent);
    expect(outbox.nextState).to.equal(SessionState.Idle);
    const queuedState = await vault.crossChainState();
    expect(queuedState.state).to.equal(SessionState.ApprovalRequested);
    expect(queuedState.outboxExists).to.equal(true);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await router.setFailGetFee(false);
    await router.setFee(1n);
    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(false);
    const dispatchedState = await vault.crossChainState();
    expect(dispatchedState.outboxExists).to.equal(false);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([await asset.getAddress(), 777n]);
  });

  it("accounting manualReset sends fresh Reset from a fully idle vault", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("manualResetCrossChainSession", [destinationChainId]),
      );
    const reset = await findEventArgs(tx, "CrossChainSessionReset", await vault.getAddress());
    expect(reset.targetChainId).to.equal(destinationChainId);
    expect(reset.nonce).to.equal(1n);
    const queued = await findEventArgs(tx, "CrossChainOutboxQueued", await vault.getAddress());
    expect(queued.targetChainId).to.equal(destinationChainId);
    expect(queued.messageType).to.equal(MessageType.Reset);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.Reset);
    expect(payload.sessionNonce).to.equal(1n);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.amount).to.equal(0n);
    expect(await router.lastTokenAmountCount()).to.equal(0n);
  });

  it("emergency reset requires the core cross-chain guard permission", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager } = fixture;

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("emergencyResetCrossChainSession"),
        ),
    )
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(assetManager.address);
  });

  it("accounting manualReset rejects zero and accounting-chain targets", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("manualResetCrossChainSession", [0n]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.InvalidChain);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("manualResetCrossChainSession", [accountingChainId]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.InvalidChain);
  });

  it("accounting manualReset rejects active local sessions", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("manualResetCrossChainSession", [destinationChainId]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.Active);
  });

  it("emergency reset clears accounting-chain state when no outbox exists", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await grantCrossChainGuard(fixture);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.TransferDispatched);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("emergencyResetCrossChainSession"));
    const reset = await findEventArgs(tx, "CrossChainSessionReset", await vault.getAddress());
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    expect(reset.targetChainId).to.equal(localChainId);
    expect(reset.nonce).to.equal(1n);
    await expectIdleWithNoOutbox(vault);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("emergency reset rejects sessions with an outbox", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await grantCrossChainGuard(fixture);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(true);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("emergencyResetCrossChainSession"),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.Active);
  });

  it("accounting manualReset keeps Reset outbox when dispatch fails", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("manualResetCrossChainSession", [destinationChainId]),
      );

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(destinationChainId);
    expect(outbox.message.messageType).to.equal(MessageType.Reset);
    expect(outbox.message.sessionNonce).to.equal(1n);
    expect(outbox.message.amount).to.equal(0n);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("accounting ignores inbound TransferRequest while a Reset outbox is queued", async function () {
    const fixture = await deployFixture();
    const { core, vault, adapter, assetManager, router, registrar } = fixture;
    const accountingChainId = (await ethers.provider.getNetwork()).chainId;
    const resetTargetChainId = 42_161n;
    const requestSourceChainId = 10n;
    await configureDispatch(fixture, resetTargetChainId);
    await core.connect(registrar).setCCIPSelector(requestSourceChainId, 4_001n);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("manualResetCrossChainSession", [resetTargetChainId]),
      );
    const resetOutbox = await readCrossChainOutbox(ethers, vault);
    expect(resetOutbox.exists).to.equal(true);
    expect(resetOutbox.message.messageType).to.equal(MessageType.Reset);

    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("blocked-transfer-request")),
      sourceChainSelector: 4_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, requestSourceChainId, accountingChainId, 77n, 100n),
      destTokenAmounts: [],
    });

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(resetTargetChainId);
    expect(outbox.message.messageType).to.equal(MessageType.Reset);
    expect(outbox.message.sessionNonce).to.equal(resetOutbox.message.sessionNonce);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
  });

  it("manualResend succeeds for failed Reset and unlocks settlement", async function () {
    const fixture = await deployFixture();
    const { vault, adapter, assetManager, router } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFailGetFee(true);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("manualResetCrossChainSession", [destinationChainId]),
      );
    expect((await readCrossChainOutbox(ethers, vault)).message.messageType).to.equal(MessageType.Reset);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await router.setFailGetFee(false);
    await router.setFee(1n);
    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.Reset);
    expect(payload.sessionNonce).to.equal(1n);
  });

  it("manualResend sends a failed TransferApproval and keeps accounting awaiting satellite completion", async function () {
    const fixture = await deployFixture();
    const { core, router, vault, registrar, feeToken, asset, adapter, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceChainId = 10n;
    await core.connect(registrar).setCCIPSelector(sourceChainId, 4_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFailGetFee(true);

    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("request-approval-fail")),
      sourceChainSelector: 4_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, sourceChainId, localChainId, 91n, 300n),
      destTokenAmounts: [],
    });

    let outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.message.messageType).to.equal(MessageType.TransferApproval);
    expect(outbox.nextState).to.equal(SessionState.AwaitingSatelliteCompletion);

    await router.setFailGetFee(false);
    await router.setFee(0n);
    await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("manualResendCrossChainMessage"));

    outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(false);
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.TransferApproval);
    expect(payload.sessionNonce).to.equal(91n);
  });

  it("satellite manualReset is forbidden", async function () {
    const fixture = await deployFixture(1n);
    const { vault, adapter, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          CROSS_CHAIN_ADAPTER_ID,
          adapter.interface.encodeFunctionData("manualResetCrossChainSession", [localChainId]),
        ),
    )
      .to.be.revertedWithCustomError(vault, "CrossChainFlowError")
      .withArgs(CrossChainFlow.AccountingChainOnly);
  });

  it("emergency reset clears satellite-chain state when no outbox exists", async function () {
    const fixture = await deployFixture(1n);
    const { vault, adapter, assetManager } = fixture;
    const accountingChainId = 1n;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, accountingChainId);
    await grantCrossChainGuard(fixture);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    const tx = await vault
      .connect(assetManager)
      .executeAdapter(CROSS_CHAIN_ADAPTER_ID, adapter.interface.encodeFunctionData("emergencyResetCrossChainSession"));
    const reset = await findEventArgs(tx, "CrossChainSessionReset", await vault.getAddress());
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    expect(reset.targetChainId).to.equal(localChainId);
    expect(reset.nonce).to.equal(1n);
    await expectIdleWithNoOutbox(vault);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("satellite accepts Reset from accounting and clears local state", async function () {
    const fixture = await deployFixture(1n);
    const { core, router, vault, registrar, feeToken, asset, adapter, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [42_161n, 100n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);

    const tx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("reset")),
      sourceChainSelector: 8_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.Reset, accountingChainId, localChainId, 1n, 0n),
      destTokenAmounts: [],
    });
    const reset = await findEventArgs(tx, "CrossChainSessionReset", await vault.getAddress());
    expect(reset.targetChainId).to.equal(localChainId);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("satellite accepts TransferApproval and immediately sends TransferSent on successful dispatch", async function () {
    const fixture = await deployFixture(1n);
    const { core, router, vault, registrar, feeToken, asset, adapter, assetManager } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const destinationChainId = 42_161n;
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);
    await core.connect(registrar).setCCIPSelector(destinationChainId, 9_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 777n]),
      );
    expect((await vault.crossChainState()).state).to.equal(SessionState.ApprovalRequested);

    const tx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("approval-success")),
      sourceChainSelector: 8_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferApproval, localChainId, destinationChainId, 1n, 777n),
      destTokenAmounts: [],
    });
    await findEventArgs(tx, "CrossChainDispatchSucceeded", await vault.getAddress());

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([await asset.getAddress(), 777n]);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.TransferSent);
    expect(payload.destinationChainId).to.equal(destinationChainId);
    expect(payload.amount).to.equal(777n);
  });

  it("ignores invalid payload / selector / sender / token validation failures", async function () {
    const fixture = await deployFixture();
    const { core, router, vault, registrar, asset, feeToken } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const remoteChainId = 42_161n;
    const remoteSelector = 4_949_039_107_694_359_620n;
    await core.connect(registrar).setCCIPSelector(remoteChainId, remoteSelector);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);

    const badDataTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-data")),
      sourceChainSelector: remoteSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: "0x1234",
      destTokenAmounts: [],
    });
    await findEventArgs(badDataTx, "CrossChainMessageIgnored", await vault.getAddress());

    const selectorMismatchTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-selector")),
      sourceChainSelector: remoteSelector + 1n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, remoteChainId, localChainId, 1n, 77n),
      destTokenAmounts: [],
    });
    await findEventArgs(selectorMismatchTx, "CrossChainMessageIgnored", await vault.getAddress());

    const badSenderTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-sender")),
      sourceChainSelector: remoteSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await router.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, remoteChainId, localChainId, 2n, 77n),
      destTokenAmounts: [],
    });
    await findEventArgs(badSenderTx, "CrossChainMessageIgnored", await vault.getAddress());

    const badSenderLengthTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-sender-length")),
      sourceChainSelector: remoteSelector,
      sender: "0x1234",
      data: encodeCrossChainMessage(MessageType.TransferRequest, remoteChainId, localChainId, 3n, 77n),
      destTokenAmounts: [],
    });
    await findEventArgs(badSenderLengthTx, "CrossChainMessageIgnored", await vault.getAddress());

    const badSenderPrefixTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-sender-prefix")),
      sourceChainSelector: remoteSelector,
      sender: ethers.concat(["0x000000000000000000000001", await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, remoteChainId, localChainId, 4n, 77n),
      destTokenAmounts: [],
    });
    await findEventArgs(badSenderPrefixTx, "CrossChainMessageIgnored", await vault.getAddress());

    await core.connect(registrar).setCCIPSelector(localChainId, remoteSelector);
    const badDestinationTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-destination")),
      sourceChainSelector: remoteSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.Reset, localChainId, remoteChainId, 5n, 0n),
      destTokenAmounts: [],
    });
    await findEventArgs(badDestinationTx, "CrossChainMessageIgnored", await vault.getAddress());

    const badTokenTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("bad-token")),
      sourceChainSelector: remoteSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferSent, remoteChainId, localChainId, 3n, 77n),
      destTokenAmounts: [{ token: await asset.getAddress(), amount: 0n }],
    });
    await findEventArgs(badTokenTx, "CrossChainMessageIgnored", await vault.getAddress());

    const wrongToken = await ethers.deployContract("MockERC20", ["Wrong Token", "WRONG", 18]);
    const wrongTokenTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("wrong-token")),
      sourceChainSelector: remoteSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferSent, remoteChainId, localChainId, 6n, 77n),
      destTokenAmounts: [{ token: await wrongToken.getAddress(), amount: 77n }],
    });
    await findEventArgs(wrongTokenTx, "CrossChainMessageIgnored", await vault.getAddress());

    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("satellite accepts TransferSent with actual delivered amount and dispatches TransferReceipt", async function () {
    const fixture = await deployFixture(1n);
    const { core, router, vault, registrar, feeToken } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const accountingChainId = 1n;
    const sourceChainId = 10n;
    const crossChainToken = await ethers.deployContract("MockERC20", ["CCIP USDC", "ccUSDC", 18]);
    await core.connect(registrar).setCCIPSelector(sourceChainId, 9_001n);
    await core.connect(registrar).setCCIPSelector(accountingChainId, 8_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await crossChainToken.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFee(1n);

    const actualDelivered = 123n;
    const tx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("sent-receipt")),
      sourceChainSelector: 9_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferSent, sourceChainId, localChainId, 11n, 999_999n),
      destTokenAmounts: [{ token: await crossChainToken.getAddress(), amount: actualDelivered }],
    });

    const completed = await findEventArgs(tx, "CrossChainTransferCompleted", await vault.getAddress());
    expect(completed.sourceChainId).to.equal(sourceChainId);
    expect(completed.destinationChainId).to.equal(localChainId);
    expect(completed.amount).to.equal(actualDelivered);
    expect(completed.nonce).to.equal(11n);
    const payload = decodeRouterPayload(await router.lastData());
    expect(payload.messageType).to.equal(MessageType.TransferReceipt);
    expect(payload.sourceChainId).to.equal(sourceChainId);
    expect(payload.destinationChainId).to.equal(localChainId);
    expect(payload.sessionNonce).to.equal(11n);
    expect(payload.amount).to.equal(actualDelivered);
    expect(await vault.settlementAllowedAt()).to.be.gt(0n);
  });

  it("accounting accepts TransferRequest then completes satellite->accounting on TransferSent", async function () {
    const fixture = await deployFixture();
    const { core, router, vault, registrar, feeToken, asset } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const sourceChainId = 10n;
    await core.connect(registrar).setCCIPSelector(sourceChainId, 4_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainToken(await asset.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFee(1n);

    const requestTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("request")),
      sourceChainSelector: 4_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferRequest, sourceChainId, localChainId, 33n, 200n),
      destTokenAmounts: [],
    });
    const queued = await findEventArgs(requestTx, "CrossChainOutboxQueued", await vault.getAddress());
    expect(queued.targetChainId).to.equal(sourceChainId);
    expect(queued.messageType).to.equal(MessageType.TransferApproval);
    expect(queued.nonce).to.equal(33n);
    expect((await vault.crossChainState()).state).to.equal(SessionState.AwaitingSatelliteCompletion);

    const sentTx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("sent")),
      sourceChainSelector: 4_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferSent, sourceChainId, localChainId, 33n, 200n),
      destTokenAmounts: [{ token: await asset.getAddress(), amount: 120n }],
    });

    const completed = await findEventArgs(sentTx, "CrossChainTransferCompleted", await vault.getAddress());
    expect(completed.sourceChainId).to.equal(sourceChainId);
    expect(completed.destinationChainId).to.equal(localChainId);
    expect(completed.amount).to.equal(120n);
    expect(completed.nonce).to.equal(33n);
    expect((await vault.crossChainState()).state).to.equal(SessionState.Idle);
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);
  });

  it("accounting accepts TransferReceipt completion and can reduce MaxUint lock", async function () {
    const fixture = await deployFixture();
    const { core, router, vault, adapter, assetManager, registrar, feeToken } = fixture;
    const destinationChainId = 42_161n;
    await configureDispatch(fixture, destinationChainId);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 50n]),
      );
    expect(await vault.settlementAllowedAt()).to.equal(ethers.MaxUint256);

    await core.connect(registrar).setCCIPSelector(destinationChainId, 7_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);

    const tx = await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("receipt")),
      sourceChainSelector: 7_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(
        MessageType.TransferReceipt,
        (await ethers.provider.getNetwork()).chainId,
        destinationChainId,
        1n,
        49n,
      ),
      destTokenAmounts: [],
    });
    await findEventArgs(tx, "CrossChainTransferCompleted", await vault.getAddress());
    expect(await vault.settlementAllowedAt()).to.not.equal(ethers.MaxUint256);
  });

  it("satellite TransferSent overwrites existing outbox and keeps receipt outbox on dispatch failure", async function () {
    const fixture = await deployFixture(1n);
    const { core, router, vault, adapter, assetManager, registrar, feeToken, asset } = fixture;
    const localChainId = (await ethers.provider.getNetwork()).chainId;
    const destinationChainId = 42_161n;
    const sourceChainId = 10n;
    await configureDispatch(fixture, 1n);
    await router.setFee(1n);

    await vault
      .connect(assetManager)
      .executeAdapter(
        CROSS_CHAIN_ADAPTER_ID,
        adapter.interface.encodeFunctionData("crossChainTransfer", [destinationChainId, 10n]),
      );
    expect((await readCrossChainOutbox(ethers, vault)).exists).to.equal(false);

    await core.connect(registrar).setCCIPSelector(sourceChainId, 4_001n);
    await core.connect(registrar).setCCIPSelector(1n, 8_001n);
    await core.connect(registrar).setCrossChainRouter(await router.getAddress());
    await core.connect(registrar).setCrossChainFeeToken(await feeToken.getAddress());
    await core.connect(registrar).setCrossChainGasLimit(500_000n);
    await router.setFailGetFee(true);

    await router.deliver(await vault.getAddress(), {
      messageId: ethers.keccak256(ethers.toUtf8Bytes("sent-precedence")),
      sourceChainSelector: 4_001n,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await vault.getAddress()]),
      data: encodeCrossChainMessage(MessageType.TransferSent, sourceChainId, localChainId, 77n, 1000n),
      destTokenAmounts: [{ token: await asset.getAddress(), amount: 55n }],
    });

    const outbox = await readCrossChainOutbox(ethers, vault);
    expect(outbox.exists).to.equal(true);
    expect(outbox.targetChainId).to.equal(1n);
    expect(outbox.message.messageType).to.equal(MessageType.TransferReceipt);
    expect(outbox.message.sessionNonce).to.equal(77n);
    expect(outbox.message.amount).to.equal(55n);
  });
});
