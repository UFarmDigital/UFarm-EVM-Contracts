import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const VERSION = 1;
const MessageType = {
  TransferRequest: 0,
  TransferApproval: 1,
  TransferSent: 2,
  TransferReceipt: 3,
  Reset: 4,
} as const;

describe("CrossChainCodec", function () {
  async function deployFixture() {
    const harness = await ethers.deployContract("CrossChainCodecHarness");
    const baseMessage = {
      version: VERSION,
      messageType: MessageType.TransferRequest,
      sourceChainId: 42161n,
      destinationChainId: 43114n,
      sessionNonce: 9n,
      amount: 123n,
    };

    return { harness, baseMessage };
  }

  it("round-trips a valid message", async function () {
    const { harness, baseMessage } = await deployFixture();
    const encoded = await harness.encode(baseMessage);
    const [ok, decoded] = await harness.decode(encoded);

    expect(ok).to.equal(true);
    expect(decoded.version).to.equal(baseMessage.version);
    expect(decoded.messageType).to.equal(baseMessage.messageType);
    expect(decoded.sourceChainId).to.equal(baseMessage.sourceChainId);
    expect(decoded.destinationChainId).to.equal(baseMessage.destinationChainId);
    expect(decoded.sessionNonce).to.equal(baseMessage.sessionNonce);
    expect(decoded.amount).to.equal(baseMessage.amount);
  });

  it("returns false on wrong length", async function () {
    const { harness } = await deployFixture();
    const [ok] = await harness.decode("0x1234");
    expect(ok).to.equal(false);
  });

  it("returns false on wrong version", async function () {
    const { harness, baseMessage } = await deployFixture();
    const raw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
      [
        2,
        baseMessage.messageType,
        baseMessage.sourceChainId,
        baseMessage.destinationChainId,
        baseMessage.sessionNonce,
        baseMessage.amount,
      ],
    );

    const [ok] = await harness.decode(raw);
    expect(ok).to.equal(false);
  });

  it("returns false on invalid enum value", async function () {
    const { harness, baseMessage } = await deployFixture();
    const raw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
      [
        VERSION,
        99,
        baseMessage.sourceChainId,
        baseMessage.destinationChainId,
        baseMessage.sessionNonce,
        baseMessage.amount,
      ],
    );

    const [ok] = await harness.decode(raw);
    expect(ok).to.equal(false);
  });

  it("returns false on zero source or destination", async function () {
    const { harness, baseMessage } = await deployFixture();
    const zeroSource = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
      [
        VERSION,
        baseMessage.messageType,
        0,
        baseMessage.destinationChainId,
        baseMessage.sessionNonce,
        baseMessage.amount,
      ],
    );
    const zeroDestination = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
      [VERSION, baseMessage.messageType, baseMessage.sourceChainId, 0, baseMessage.sessionNonce, baseMessage.amount],
    );

    const [okSource] = await harness.decode(zeroSource);
    const [okDestination] = await harness.decode(zeroDestination);

    expect(okSource).to.equal(false);
    expect(okDestination).to.equal(false);
  });

  it("rejects zero amount for request and approval message types", async function () {
    const { harness, baseMessage } = await deployFixture();
    const rejectedTypes = [MessageType.TransferRequest, MessageType.TransferApproval];

    for (const messageType of rejectedTypes) {
      const raw = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
        [VERSION, messageType, baseMessage.sourceChainId, baseMessage.destinationChainId, baseMessage.sessionNonce, 0],
      );
      const [ok] = await harness.decode(raw);
      expect(ok).to.equal(false);
    }
  });

  it("accepts zero amount for TransferSent, TransferReceipt, and Reset", async function () {
    const { harness, baseMessage } = await deployFixture();
    const acceptedTypes = [MessageType.TransferSent, MessageType.TransferReceipt, MessageType.Reset];

    for (const messageType of acceptedTypes) {
      const raw = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
        [VERSION, messageType, baseMessage.sourceChainId, baseMessage.destinationChainId, baseMessage.sessionNonce, 0],
      );

      const [ok, decoded] = await harness.decode(raw);
      expect(ok).to.equal(true);
      expect(decoded.messageType).to.equal(messageType);
      expect(decoded.amount).to.equal(0n);
    }
  });

  it("rejects non-zero amount for Reset", async function () {
    const { harness, baseMessage } = await deployFixture();
    const raw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
      [
        VERSION,
        MessageType.Reset,
        baseMessage.sourceChainId,
        baseMessage.destinationChainId,
        baseMessage.sessionNonce,
        1,
      ],
    );

    const [ok] = await harness.decode(raw);
    expect(ok).to.equal(false);
  });
});
