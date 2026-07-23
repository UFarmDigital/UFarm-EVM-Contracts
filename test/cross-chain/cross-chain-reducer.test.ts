import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const MessageType = {
  TransferRequest: 0,
  TransferApproval: 1,
  TransferSent: 2,
  TransferReceipt: 3,
  Reset: 4,
} as const;

const SessionState = {
  Idle: 0,
  ApprovalRequested: 1,
  TransferDispatched: 2,
  AwaitingSatelliteCompletion: 3,
} as const;

const Action = {
  Ignore: 0,
  AcceptRequest: 1,
  AcceptApproval: 2,
  AcceptTransfer: 3,
  AcceptReceipt: 4,
  ApplyReset: 5,
} as const;

describe("CrossChainReducer", function () {
  async function deployFixture() {
    const harness = await ethers.deployContract("CrossChainReducerHarness");
    const accountingChainId = 1n;
    const sourceChainId = 10n;
    const destinationChainId = 20n;
    const nonce = 7n;

    function message(
      messageType: number,
      source = sourceChainId,
      destination = accountingChainId,
      sessionNonce = nonce,
      amount = messageType === MessageType.Reset ? 0n : 100n,
    ) {
      return {
        version: 1,
        messageType,
        sourceChainId: source,
        destinationChainId: destination,
        sessionNonce,
        amount,
      };
    }

    function state(
      sessionState: number,
      source = sourceChainId,
      destination = destinationChainId,
      sessionNonce = nonce,
      outboxExists = false,
    ) {
      return {
        nonce: sessionNonce,
        sourceChainId: source,
        destinationChainId: destination,
        state: sessionState,
        outbox: {
          exists: outboxExists,
          targetChainId: sourceChainId,
          nextState: SessionState.Idle,
          message: message(MessageType.Reset, accountingChainId, sourceChainId, sessionNonce),
        },
        sessionNonce,
      };
    }

    return { harness, accountingChainId, sourceChainId, destinationChainId, nonce, message, state };
  }

  it("accounting accepts satellite TransferRequest only from full idle", async function () {
    const { harness, accountingChainId, sourceChainId, nonce, message, state } = await deployFixture();

    const accepted = await harness.accountingAction(
      message(MessageType.TransferRequest, sourceChainId, accountingChainId),
      state(SessionState.Idle, sourceChainId, accountingChainId, nonce),
      accountingChainId,
    );
    expect(accepted).to.equal(Action.AcceptRequest);

    const blockedByOutbox = await harness.accountingAction(
      message(MessageType.TransferRequest, sourceChainId, accountingChainId),
      state(SessionState.Idle, sourceChainId, accountingChainId, nonce, true),
      accountingChainId,
    );
    expect(blockedByOutbox).to.equal(Action.Ignore);
  });

  it("accounting accepts satellite-to-satellite TransferRequest from full idle", async function () {
    const { harness, accountingChainId, sourceChainId, destinationChainId, nonce, message, state } =
      await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferRequest, sourceChainId, destinationChainId),
      state(SessionState.Idle, sourceChainId, destinationChainId, nonce),
      accountingChainId,
    );

    expect(action).to.equal(Action.AcceptRequest);
  });

  it("busy accounting ignores additional TransferRequest", async function () {
    const { harness, accountingChainId, sourceChainId, nonce, message, state } = await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferRequest, sourceChainId, accountingChainId),
      state(SessionState.TransferDispatched, sourceChainId, accountingChainId, nonce),
      accountingChainId,
    );

    expect(action).to.equal(Action.Ignore);
  });

  it("accounting finalizes accounting-to-satellite on TransferReceipt", async function () {
    const { harness, accountingChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferReceipt, accountingChainId, destinationChainId),
      state(SessionState.TransferDispatched, accountingChainId, destinationChainId, nonce),
      accountingChainId,
    );

    expect(action).to.equal(Action.AcceptReceipt);
  });

  it("accounting finalizes satellite-to-accounting on TransferSent", async function () {
    const { harness, accountingChainId, sourceChainId, nonce, message, state } = await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferSent, sourceChainId, accountingChainId),
      state(SessionState.AwaitingSatelliteCompletion, sourceChainId, accountingChainId, nonce),
      accountingChainId,
    );

    expect(action).to.equal(Action.AcceptTransfer);
  });

  it("accounting finalizes satellite-to-satellite on TransferReceipt", async function () {
    const { harness, accountingChainId, sourceChainId, destinationChainId, nonce, message, state } =
      await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferReceipt, sourceChainId, destinationChainId),
      state(SessionState.AwaitingSatelliteCompletion, sourceChainId, destinationChainId, nonce),
      accountingChainId,
    );

    expect(action).to.equal(Action.AcceptReceipt);
  });

  it("accounting ignores completions while an outbox is queued", async function () {
    const { harness, accountingChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const action = await harness.accountingAction(
      message(MessageType.TransferReceipt, accountingChainId, destinationChainId),
      state(SessionState.TransferDispatched, accountingChainId, destinationChainId, nonce, true),
      accountingChainId,
    );

    expect(action).to.equal(Action.Ignore);
  });

  it("session-key mismatch is ignored for accounting completions", async function () {
    const { harness, accountingChainId, sourceChainId, destinationChainId, nonce, message, state } =
      await deployFixture();

    const session = state(SessionState.TransferDispatched, sourceChainId, destinationChainId, nonce);
    const wrongSource = await harness.accountingAction(
      message(MessageType.TransferReceipt, sourceChainId + 1n, destinationChainId, nonce),
      session,
      accountingChainId,
    );
    expect(wrongSource).to.equal(Action.Ignore);

    const wrongDestination = await harness.accountingAction(
      message(MessageType.TransferReceipt, sourceChainId, destinationChainId + 1n, nonce),
      session,
      accountingChainId,
    );
    expect(wrongDestination).to.equal(Action.Ignore);

    const wrongNonce = await harness.accountingAction(
      message(MessageType.TransferReceipt, sourceChainId, destinationChainId, nonce + 1n),
      session,
      accountingChainId,
    );
    expect(wrongNonce).to.equal(Action.Ignore);
  });

  it("satellite accepts TransferApproval only with exact session key and no outbox", async function () {
    const { harness, sourceChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const accepted = await harness.satelliteAction(
      message(MessageType.TransferApproval, sourceChainId, destinationChainId),
      state(SessionState.ApprovalRequested, sourceChainId, destinationChainId, nonce),
      destinationChainId,
    );
    expect(accepted).to.equal(Action.AcceptApproval);

    const ignored = await harness.satelliteAction(
      message(MessageType.TransferApproval, sourceChainId, destinationChainId, nonce + 1n),
      state(SessionState.ApprovalRequested, sourceChainId, destinationChainId, nonce),
      destinationChainId,
    );
    expect(ignored).to.equal(Action.Ignore);

    const blockedByOutbox = await harness.satelliteAction(
      message(MessageType.TransferApproval, sourceChainId, destinationChainId),
      state(SessionState.ApprovalRequested, sourceChainId, destinationChainId, nonce, true),
      destinationChainId,
    );
    expect(blockedByOutbox).to.equal(Action.Ignore);
  });

  it("satellite accepts TransferSent in every state when no outbox exists", async function () {
    const { harness, sourceChainId, destinationChainId, nonce, message, state } = await deployFixture();
    for (const sessionState of Object.values(SessionState)) {
      const action = await harness.satelliteAction(
        message(MessageType.TransferSent, sourceChainId, destinationChainId),
        state(sessionState, sourceChainId + 100n, destinationChainId + 100n, nonce + 100n),
        destinationChainId,
      );

      expect(action).to.equal(Action.AcceptTransfer);
    }
  });

  it("satellite accepts TransferSent while an outbox is queued", async function () {
    const { harness, sourceChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const action = await harness.satelliteAction(
      message(MessageType.TransferSent, sourceChainId, destinationChainId),
      state(SessionState.ApprovalRequested, sourceChainId, destinationChainId, nonce, true),
      destinationChainId,
    );

    expect(action).to.equal(Action.AcceptTransfer);
  });

  it("satellite ignores TransferSent when destination is not local chain", async function () {
    const { harness, sourceChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const action = await harness.satelliteAction(
      message(MessageType.TransferSent, sourceChainId, destinationChainId + 1n),
      state(SessionState.ApprovalRequested, sourceChainId, destinationChainId, nonce),
      destinationChainId,
    );

    expect(action).to.equal(Action.Ignore);
  });

  it("satellite ignores Reset while an outbox is queued", async function () {
    const { harness, sourceChainId, destinationChainId, nonce, message, state } = await deployFixture();

    const action = await harness.satelliteAction(
      message(MessageType.Reset, sourceChainId, destinationChainId),
      state(SessionState.TransferDispatched, sourceChainId, destinationChainId, nonce, true),
      destinationChainId,
    );

    expect(action).to.equal(Action.Ignore);
  });
});
