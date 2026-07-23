import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";
import { configureValueToken } from "../helpers/value-token";

const { ethers } = await network.create();

const WAD = 10n ** 18n;
const MAX_AGE = 86400n;
const MIN_PRICE = 99n * 10n ** 16n;
const MAX_PRICE = 101n * 10n ** 16n;

async function deployCore() {
  const [authority, other] = await ethers.getSigners();
  const { core, createX } = await deployConfiguredCore(ethers, authority);
  return { core, createX, authority, other };
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function scalePrice(answer: bigint, decimals: bigint) {
  return decimals === 18n ? answer : answer * 10n ** (18n - decimals);
}

describe("UFarmCore value token pricing", function () {
  it("stores config, emits the existing update event, and exposes the packed getter", async function () {
    const { core } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const feed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);

    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    )
      .to.emit(core, "ValueTokenUpdated")
      .withArgs(await asset.getAddress(), true);

    const config = await core.valueTokenConfig(await asset.getAddress());
    expect(config.feed).to.equal(await feed.getAddress());
    expect(config.tokenUnit).to.equal(10n ** 6n);
    expect(config.maxPriceAge).to.equal(MAX_AGE);
    expect(config.feedUnit).to.equal(10n ** 8n);
    expect(config.minPrice).to.equal(MIN_PRICE);
    expect(config.maxPrice).to.equal(MAX_PRICE);
  });

  it("prices and converts at $1, $0.99, and $1.01 across feed decimal variants", async function () {
    const cases = [
      { feedDecimals: 6, answers: [1000000n, 990000n, 1010000n] },
      { feedDecimals: 8, answers: [100000000n, 99000000n, 101000000n] },
      { feedDecimals: 18, answers: [WAD, 99n * 10n ** 16n, 101n * 10n ** 16n] },
    ];

    for (const { feedDecimals, answers } of cases) {
      const { core } = await deployCore();
      const asset = await ethers.deployContract("MockERC20", [`USD${feedDecimals}`, `USD${feedDecimals}`, 18]);
      const feed = await ethers.deployContract("MockChainlinkAggregator", [feedDecimals, answers[0]]);

      await core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE);

      for (const answer of answers) {
        const now = await latestTimestamp();
        await feed.setRoundData(answer, now);

        const priceWad = scalePrice(answer, BigInt(feedDecimals));
        expect(await core.valueTokenToUsd(await asset.getAddress(), WAD)).to.equal(priceWad);
        expect(await core.usdToValueToken(await asset.getAddress(), priceWad)).to.equal(WAD);
        expect(await core.usdToValueToken(await asset.getAddress(), WAD)).to.equal((WAD * WAD) / priceWad);
      }
    }
  });

  it("returns zero for unknown tokens, zero inputs, invalid runtime prices, and overflowed math", async function () {
    const { core } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const feed = await configureValueToken(ethers, core, asset);
    const assetAddress = await asset.getAddress();
    const now = await latestTimestamp();

    expect(await core.valueTokenToUsd(assetAddress, 0n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 0n)).to.equal(0n);
    expect(await core.valueTokenToUsd(ethers.ZeroAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(ethers.ZeroAddress, 1n)).to.equal(0n);

    await feed.setRoundData(0n, now);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(-1n, now);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(100000000n, 0n);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(100000000n, now + MAX_AGE + 100n);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(100000000n, now - MAX_AGE - 1n);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(89000000n, now);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setRoundData(111000000n, now);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setShouldRevert(true);
    expect(await core.valueTokenToUsd(assetAddress, 1n)).to.equal(0n);
    expect(await core.usdToValueToken(assetAddress, 1n)).to.equal(0n);

    await feed.setShouldRevert(false);
    await feed.setRoundData(100000000n, now);
    expect(await core.valueTokenToUsd(assetAddress, (1n << 256n) - 1n)).to.equal((1n << 256n) - 1n);
    expect(await core.usdToValueToken(assetAddress, (1n << 256n) - 1n)).to.equal((1n << 256n) - 1n);
  });

  it("returns zero when the final conversion result would overflow uint256", async function () {
    const { core } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const feed = await configureValueToken(ethers, core, asset);
    const assetAddress = await asset.getAddress();
    const now = await latestTimestamp();
    const maxUint256 = (1n << 256n) - 1n;

    await feed.setRoundData(101000000n, now);
    expect(await core.valueTokenToUsd(assetAddress, maxUint256)).to.equal(0n);

    await feed.setRoundData(99000000n, now);
    expect(await core.usdToValueToken(assetAddress, maxUint256)).to.equal(0n);
  });

  it("keeps fitting quotients when the intermediate multiplication overflows", async function () {
    const { core } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);

    await configureValueToken(ethers, core, asset, { decimals: 18, answer: WAD });

    const largeAmount = 1n << 200n;
    expect(await core.valueTokenToUsd(await asset.getAddress(), largeAmount)).to.equal(largeAmount);
    expect(await core.usdToValueToken(await asset.getAddress(), largeAmount)).to.equal(largeAmount);
    expect(
      await core.usdToValueToken(
        await asset.getAddress(),
        await core.valueTokenToUsd(await asset.getAddress(), largeAmount),
      ),
    ).to.equal(largeAmount);
  });

  it("clears config and stops pricing the token", async function () {
    const { core } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);

    await configureValueToken(ethers, core, asset);

    await expect(core.clearValueTokenConfig(await asset.getAddress()))
      .to.emit(core, "ValueTokenUpdated")
      .withArgs(await asset.getAddress(), false);

    const config = await core.valueTokenConfig(await asset.getAddress());
    expect(config.feed).to.equal(ethers.ZeroAddress);
    expect(config.tokenUnit).to.equal(0n);
    expect(config.maxPriceAge).to.equal(0n);
    expect(config.feedUnit).to.equal(0n);
    expect(config.minPrice).to.equal(0n);
    expect(config.maxPrice).to.equal(0n);
    expect(await core.valueTokenToUsd(await asset.getAddress(), 1n)).to.equal(0n);
    expect(await core.usdToValueToken(await asset.getAddress(), 1n)).to.equal(0n);
  });

  it("validates addresses, bounds, decimals, and current price when setting config", async function () {
    const { core, createX, other } = await deployCore();
    const asset = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const feed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);
    const highDecimalsAsset = await ethers.deployContract("MockERC20", ["Too Many Decimals", "MANY", 19]);
    const highDecimalsFeed = await ethers.deployContract("MockChainlinkAggregator", [19, 1000000000000000000n]);
    const staleFeed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);
    const zeroAnswerFeed = await ethers.deployContract("MockChainlinkAggregator", [8, 0n]);
    const negativeAnswerFeed = await ethers.deployContract("MockChainlinkAggregator", [8, -1n]);
    const outOfBandFeed = await ethers.deployContract("MockChainlinkAggregator", [8, 111000000n]);
    const revertingFeed = await ethers.deployContract("MockChainlinkAggregator", [8, 100000000n]);
    const now = await latestTimestamp();

    await staleFeed.setRoundData(100000000n, now - MAX_AGE - 1n);
    await revertingFeed.setShouldRevert(true);

    await expect(
      core
        .connect(other)
        .setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    )
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(other.address);

    await expect(
      core.setValueTokenConfig(ethers.ZeroAddress, await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), ethers.ZeroAddress, MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");
    await expect(
      core.setValueTokenConfig(other.address, await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), other.address, MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidAddress");
    await expect(core.clearValueTokenConfig(ethers.ZeroAddress)).to.be.revertedWithCustomError(core, "InvalidAddress");

    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), 0n, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, 0n, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, MIN_PRICE, 0n),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await feed.getAddress(), MAX_AGE, MAX_PRICE, MIN_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");

    await expect(
      core.setValueTokenConfig(await createX.getAddress(), await feed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await createX.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await highDecimalsAsset.getAddress(),
        await feed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await asset.getAddress(),
        await highDecimalsFeed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(await asset.getAddress(), await staleFeed.getAddress(), MAX_AGE, MIN_PRICE, MAX_PRICE),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await asset.getAddress(),
        await zeroAnswerFeed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await asset.getAddress(),
        await negativeAnswerFeed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await asset.getAddress(),
        await outOfBandFeed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
    await expect(
      core.setValueTokenConfig(
        await asset.getAddress(),
        await revertingFeed.getAddress(),
        MAX_AGE,
        MIN_PRICE,
        MAX_PRICE,
      ),
    ).to.be.revertedWithCustomError(core, "InvalidConfig");
  });
});
