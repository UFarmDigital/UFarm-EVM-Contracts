import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("MockCCIPRouter", function () {
  async function deployFixture() {
    const [sender] = await ethers.getSigners();
    const router = await ethers.deployContract("MockCCIPRouter");
    const feeToken = ethers.getAddress("0x0000000000000000000000000000000000000f01");
    const token = ethers.getAddress("0x00000000000000000000000000000000000000a1");
    const token2 = ethers.getAddress("0x00000000000000000000000000000000000000a2");
    const receiver = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [sender.address]);
    const data = ethers.toUtf8Bytes("cross-chain-message");
    const extraArgs = ethers.toUtf8Bytes("v2-extra-args");
    const message = {
      receiver,
      data,
      tokenAmounts: [{ token, amount: 10n }],
      feeToken,
      extraArgs,
    };
    const secondMessage = {
      receiver,
      data: ethers.toUtf8Bytes("cross-chain-message-2"),
      tokenAmounts: [{ token: token2, amount: 22n }],
      feeToken,
      extraArgs: ethers.toUtf8Bytes("v2-extra-args-2"),
    };

    return { sender, router, message, secondMessage, receiver, data, extraArgs, feeToken, token, token2 };
  }

  it("matches Chainlink CCIP EVM2AnyMessage field order", async function () {
    const { router } = await deployFixture();
    const input = router.interface.getFunction("ccipSend").inputs[1];

    expect(input.components?.map((component) => component.name)).to.deep.equal([
      "receiver",
      "data",
      "tokenAmounts",
      "feeToken",
      "extraArgs",
    ]);
  });

  it("fee quote returns configured fee", async function () {
    const { router, message } = await deployFixture();
    await router.setFee(123_456n);

    expect(await router.getFee(4_949_039_107_694_359_620n, message)).to.equal(123_456n);
  });

  it("ccipSend emits event and records selector/sender/message fields", async function () {
    const { sender, router, message, receiver, data, extraArgs, feeToken, token } = await deployFixture();
    const destinationSelector = 1_606_861_706_215_706_843n;

    await expect(router.ccipSend(destinationSelector, message))
      .to.emit(router, "MockCCIPSent")
      .withArgs(ethers.toBeHex(1, 32), destinationSelector, sender.address);

    expect(await router.lastDestinationSelector()).to.equal(destinationSelector);
    expect(await router.lastSender()).to.equal(sender.address);
    expect(await router.lastReceiver()).to.equal(receiver);
    expect(await router.lastData()).to.equal(ethers.hexlify(data));
    expect(await router.lastExtraArgs()).to.equal(ethers.hexlify(extraArgs));
    expect(await router.lastFeeToken()).to.equal(feeToken);
    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([token, 10n]);
  });

  it("next message id increments", async function () {
    const { sender, router, message } = await deployFixture();
    const destinationSelector = 4_321n;

    const firstTx = await router.ccipSend(destinationSelector, message);
    await expect(firstTx)
      .to.emit(router, "MockCCIPSent")
      .withArgs(ethers.toBeHex(1, 32), destinationSelector, sender.address);

    const secondTx = await router.ccipSend(destinationSelector, message);
    await expect(secondTx)
      .to.emit(router, "MockCCIPSent")
      .withArgs(ethers.toBeHex(2, 32), destinationSelector, sender.address);

    expect(await router.nextMessageId()).to.equal(ethers.toBeHex(3, 32));
  });

  it("second successful send clears/replaces previous token amounts", async function () {
    const { router, message, secondMessage, token2 } = await deployFixture();
    const destinationSelector = 4_321n;

    await router.ccipSend(destinationSelector, message);
    expect(await router.lastTokenAmount(0)).to.deep.equal([message.tokenAmounts[0].token, 10n]);

    await router.ccipSend(destinationSelector, secondMessage);
    expect(await router.lastTokenAmountCount()).to.equal(1n);
    expect(await router.lastTokenAmount(0)).to.deep.equal([token2, 22n]);
    await expect(router.lastTokenAmount(1)).to.be.revertedWithPanic(0x32);
  });

  it("zero selector and empty receiver revert with invalid-message error", async function () {
    const { router, message } = await deployFixture();
    const emptyReceiverMessage = { ...message, receiver: "0x" };

    await expect(router.getFee(0n, message)).to.be.revertedWithCustomError(router, "MockCCIPRouterInvalidMessage");
    await expect(router.ccipSend(0n, message)).to.be.revertedWithCustomError(router, "MockCCIPRouterInvalidMessage");
    await expect(router.getFee(1n, emptyReceiverMessage)).to.be.revertedWithCustomError(
      router,
      "MockCCIPRouterInvalidMessage",
    );
    await expect(router.ccipSend(1n, emptyReceiverMessage)).to.be.revertedWithCustomError(
      router,
      "MockCCIPRouterInvalidMessage",
    );
  });

  it("failGetFee and failSend revert with the custom error", async function () {
    const { sender, router, message } = await deployFixture();
    const destinationSelector = 4_321n;

    await router.ccipSend(destinationSelector, message);
    const beforeMessageId = await router.nextMessageId();
    const beforeDestinationSelector = await router.lastDestinationSelector();
    const beforeSender = await router.lastSender();
    const beforeReceiver = await router.lastReceiver();
    const beforeData = await router.lastData();
    const beforeExtraArgs = await router.lastExtraArgs();
    const beforeFeeToken = await router.lastFeeToken();
    const beforeTokenAmountCount = await router.lastTokenAmountCount();
    const [beforeToken, beforeAmount] = await router.lastTokenAmount(0);

    await router.setFailGetFee(true);
    await expect(router.getFee(destinationSelector, message)).to.be.revertedWithCustomError(
      router,
      "MockCCIPRouterForcedFailure",
    );

    await router.setFailSend(true);
    await expect(router.ccipSend(destinationSelector, message)).to.be.revertedWithCustomError(
      router,
      "MockCCIPRouterForcedFailure",
    );

    expect(await router.nextMessageId()).to.equal(beforeMessageId);
    expect(await router.lastDestinationSelector()).to.equal(beforeDestinationSelector);
    expect(await router.lastSender()).to.equal(beforeSender);
    expect(await router.lastSender()).to.equal(sender.address);
    expect(await router.lastReceiver()).to.equal(beforeReceiver);
    expect(await router.lastData()).to.equal(beforeData);
    expect(await router.lastExtraArgs()).to.equal(beforeExtraArgs);
    expect(await router.lastFeeToken()).to.equal(beforeFeeToken);
    expect(await router.lastTokenAmountCount()).to.equal(beforeTokenAmountCount);
    expect(await router.lastTokenAmount(0)).to.deep.equal([beforeToken, beforeAmount]);
  });
});
