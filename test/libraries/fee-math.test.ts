import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const WAD = 1_000_000_000_000_000_000n;
const YEAR = 365n * 24n * 60n * 60n;
const MAX_PERFORMANCE_THRESHOLD_BPS = 65_535n;

function packPerformanceFeeSchedule(steps: Array<[bigint, bigint]>) {
  return steps.reduce((packed, [feeBps, thresholdBps], index) => {
    return packed | (feeBps << BigInt(index * 32)) | (thresholdBps << BigInt(index * 32 + 16));
  }, 0n);
}

describe("FeeMath", function () {
  it("calculates grossed-up annual AUM fee shares", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const tenPercent = WAD / 10n;
    const shares = await harness.aumFeeShares(1_000n, tenPercent, YEAR);

    expect(shares).to.equal(111n);
  });

  it("returns zero AUM fee shares for zero supply fee or elapsed time", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const tenPercent = WAD / 10n;

    expect(await harness.aumFeeShares(0n, tenPercent, YEAR)).to.equal(0n);
    expect(await harness.aumFeeShares(1_000n, 0n, YEAR)).to.equal(0n);
    expect(await harness.aumFeeShares(1_000n, tenPercent, 0n)).to.equal(0n);
  });

  it("caps AUM period fee at 50 percent", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");

    expect(await harness.aumFeeShares(1_000n, WAD, YEAR)).to.equal(1_000n);
    expect(await harness.aumFeeShares(1_000n, WAD * 2n, YEAR)).to.equal(1_000n);
  });

  it("calculates performance fee shares with gross-up and returns gross share price", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const twentyPercent = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    const result = await harness.performanceFeeShares(1_200n, 1_000n, WAD, twentyPercent);

    expect(result[0]).to.equal(34n);
    expect(result[1]).to.equal(1_200_000_000_000_000_000n);
  });

  it("returns zero performance fee below high-water mark", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const twentyPercent = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    const result = await harness.performanceFeeShares(900n, 1_000n, WAD, twentyPercent);

    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(900_000_000_000_000_000n);
  });

  it("returns zero performance fee when supply or schedule is zero", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const twentyPercent = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    expect(await harness.performanceFeeShares(1_200n, 0n, WAD, twentyPercent)).to.deep.equal([0n, 0n]);
    expect(await harness.performanceFeeShares(1_200n, 1_000n, WAD, 0n)).to.deep.equal([0n, 1_200_000_000_000_000_000n]);
  });

  it("returns zero performance fee for zero NAV with nonzero supply", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const twentyPercent = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    const result = await harness.performanceFeeShares(0n, 1_000n, WAD, twentyPercent);

    expect(result).to.deep.equal([0n, 0n]);
  });

  it("validates packed performance fee schedules", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const schedule = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    expect(await harness.isValidPerformanceFeeSchedule(0n)).to.equal(true);
    expect(
      await harness.isValidPerformanceFeeSchedule(
        packPerformanceFeeSchedule([[5_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]),
      ),
    ).to.equal(true);
    expect(
      await harness.isValidPerformanceFeeSchedule(
        packPerformanceFeeSchedule([[5_001n, MAX_PERFORMANCE_THRESHOLD_BPS]]),
      ),
    ).to.equal(false);
    expect(await harness.isValidPerformanceFeeSchedule(packPerformanceFeeSchedule([[1_000n, 1_000n]]))).to.equal(false);
    expect(
      await harness.isValidPerformanceFeeSchedule(
        packPerformanceFeeSchedule([
          [1_000n, 2_000n],
          [1_000n, 1_500n],
          [1_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
        ]),
      ),
    ).to.equal(false);
    expect(await harness.isValidPerformanceFeeSchedule(1n << 128n)).to.equal(false);
    expect(await harness.isValidPerformanceFeeSchedule(schedule)).to.equal(true);
    expect(await harness.isValidPerformanceFeeSchedule(schedule | ((30n * 24n * 60n * 60n) << 128n))).to.equal(true);
    expect(await harness.isValidPerformanceFeeSchedule(schedule | (1n << 200n))).to.equal(true);
    expect(await harness.isValidPerformanceFeeSchedule((30n * 24n * 60n * 60n) << 128n)).to.equal(false);
    expect(await harness.isValidPerformanceFeeSchedule(1n << 160n)).to.equal(false);
  });

  it("rejects schedules that never terminate with the max threshold", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const unterminated = packPerformanceFeeSchedule([
      [500n, 1_000n],
      [1_000n, 2_000n],
      [1_500n, 3_000n],
      [2_000n, 4_000n],
    ]);

    expect(await harness.isValidPerformanceFeeSchedule(unterminated)).to.equal(false);
  });

  it("calculates ladder performance fee shares across profit brackets", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const ladderFee = packPerformanceFeeSchedule([
      [500n, 1_000n],
      [1_000n, 1_500n],
      [3_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
    ]);

    const result = await harness.performanceFeeShares(1_200n, 1_000n, WAD, ladderFee);

    expect(result[0]).to.equal(21n);
    expect(result[1]).to.equal(1_200_000_000_000_000_000n);
  });

  it("caps a malformed performance fee schedule at half of NAV", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const excessiveFee = packPerformanceFeeSchedule([[60_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    const result = await harness.performanceFeeShares(1_200n, 1_000n, WAD, excessiveFee);

    expect(result[0]).to.equal(1_000n);
    expect(result[1]).to.equal(1_200_000_000_000_000_000n);
  });

  it("truncates a fee bracket when the share price is below its threshold", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const highThresholdFee = packPerformanceFeeSchedule([
      [2_000n, 5_000n],
      [3_000n, MAX_PERFORMANCE_THRESHOLD_BPS],
    ]);

    const result = await harness.performanceFeeShares(1_200n, 1_000n, WAD, highThresholdFee);

    expect(result[0]).to.equal(34n);
    expect(result[1]).to.equal(1_200_000_000_000_000_000n);
  });

  it("returns zero fee shares for tiny rounded-down profit while keeping elevated share price", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");
    const twentyPercent = packPerformanceFeeSchedule([[2_000n, MAX_PERFORMANCE_THRESHOLD_BPS]]);

    const result = await harness.performanceFeeShares(1001n, 1000n, WAD, twentyPercent);

    expect(result[0]).to.equal(0n);
    expect(result[1]).to.equal(1_001_000_000_000_000_000n);
  });

  it("splits curator fee shares with protocol cut rounded down", async function () {
    const harness = await ethers.deployContract("FeeMathHarness");

    expect(await harness.splitCuratorFee(101n, false)).to.deep.equal([20n, 81n]);
    expect(await harness.splitCuratorFee(101n, true)).to.deep.equal([0n, 101n]);
  });
});
