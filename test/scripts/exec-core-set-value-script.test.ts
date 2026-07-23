import { expect } from "chai";
import { executeSetValueToken, parseSetValueTokenArguments } from "../../scripts/exec-core-set-value.js";
import {
  buildFoundationCoreConfigParameters,
  refreshValueTokenPriceFeedAndBuildCoreConfigParameters,
} from "../../scripts/deploy-private-setup.js";

const CORE = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const FEED = "0x3333333333333333333333333333333333333333";
const UINT32_MAX = 4_294_967_295n;
const UINT96_MAX = 79_228_162_514_264_337_593_543_950_335n;

describe("exec core set value script", function () {
  it("configures value-token pricing with parsed arguments and waits for the transaction", async function () {
    const command = parseSetValueTokenArguments([
      "--core",
      CORE,
      "--asset",
      ASSET,
      "--feed",
      FEED,
      "--max-age",
      "86400",
      "--min-price",
      "950000000000000000",
      "--max-price",
      "1050000000000000000",
    ]);
    const calls: unknown[][] = [];
    const tx = { hash: "0xconfigure", wait: async () => ({ status: 1 }) };
    const waited: unknown[] = [];
    const core = {
      setValueTokenConfig: async (...args: unknown[]) => {
        calls.push(args);
        return tx;
      },
      clearValueTokenConfig: async () => {
        throw new Error("unexpected clear");
      },
    };

    await executeSetValueToken(command, core, async (pendingTx) => {
      waited.push(pendingTx);
      await pendingTx.wait();
    });

    expect(calls).to.deep.equal([[ASSET, FEED, 86_400n, 950_000_000_000_000_000n, 1_050_000_000_000_000_000n]]);
    expect(waited).to.deep.equal([tx]);
  });

  it("clears value-token pricing without requiring configure arguments and waits for the transaction", async function () {
    const command = parseSetValueTokenArguments(["--core", CORE, "--asset", ASSET, "--clear"]);
    const calls: string[] = [];
    const tx = { hash: "0xclear", wait: async () => ({ status: 1 }) };
    const waited: unknown[] = [];
    const core = {
      setValueTokenConfig: async () => {
        throw new Error("unexpected configure");
      },
      clearValueTokenConfig: async (asset: string) => {
        calls.push(asset);
        return tx;
      },
    };

    await executeSetValueToken(command, core, async (pendingTx) => {
      waited.push(pendingTx);
      await pendingTx.wait();
    });

    expect(calls).to.deep.equal([ASSET]);
    expect(waited).to.deep.equal([tx]);
  });

  for (const [argument, value, message] of [
    ["--max-age", "-1", "--max-age must be an unsigned integer"],
    ["--min-price", "1.5", "--min-price must be an unsigned integer"],
    ["--max-price", "wat", "--max-price must be an unsigned integer"],
    ["--max-age", (UINT32_MAX + 1n).toString(), "--max-age must be at most 4294967295"],
    ["--min-price", (UINT96_MAX + 1n).toString(), "--min-price must be at most 79228162514264337593543950335"],
    ["--max-price", (UINT96_MAX + 1n).toString(), "--max-price must be at most 79228162514264337593543950335"],
  ]) {
    it(`rejects invalid ${argument} value ${value}`, function () {
      const args = configureArgs();
      args[args.indexOf(argument) + 1] = value;

      expect(() => parseSetValueTokenArguments(args)).to.throw(message);
    });
  }

  it("rejects a minimum price above the maximum price", function () {
    const args = configureArgs();
    args[args.indexOf("--min-price") + 1] = "1050000000000000001";

    expect(() => parseSetValueTokenArguments(args)).to.throw("--min-price must be less than or equal to --max-price");
  });
});

describe("private setup core configuration parameters", function () {
  it("propagates the value token feed while preserving configured pricing and cross-chain parameters", function () {
    const parameters = {
      FoundationCoreConfig: {
        valueToken: "0x6666666666666666666666666666666666666666",
        valueTokenPriceFeed: "0x7777777777777777777777777777777777777777",
        valueTokenMaxPriceAge: 123,
        valueTokenMinPrice: "900000000000000000",
        valueTokenMaxPrice: "1100000000000000000",
      },
      FoundationAdapters: {
        crossChainToken: "0x4444444444444444444444444444444444444444",
      },
    };

    const result = buildFoundationCoreConfigParameters(parameters, {
      core: CORE,
      oracle: "0x5555555555555555555555555555555555555555",
      valueToken: ASSET,
      valueTokenPriceFeed: FEED,
    });

    expect(result.FoundationCoreConfig).to.deep.equal({
      valueTokenMaxPriceAge: 123,
      valueTokenMinPrice: "900000000000000000",
      valueTokenMaxPrice: "1100000000000000000",
      core: CORE,
      oracle: "0x5555555555555555555555555555555555555555",
      valueToken: ASSET,
      valueTokenPriceFeed: FEED,
    });
    expect(result.FoundationAdapters).to.deep.equal(parameters.FoundationAdapters);
  });

  it("refreshes the private setup feed before returning core configuration parameters", async function () {
    const parameters = {
      FoundationCoreConfig: {
        valueTokenMaxPriceAge: 86_400,
        valueTokenMinPrice: "900000000000000000",
        valueTokenMaxPrice: "1100000000000000000",
      },
    };
    const refreshTx = {
      hash: "0xrefresh",
      wait: async () => ({ status: 1 }),
    };
    const calls: Array<[bigint, bigint]> = [];
    const waited: unknown[] = [];
    const feed = {
      setRoundData: async (answer: bigint, updatedAt: bigint) => {
        calls.push([answer, updatedAt]);
        return refreshTx;
      },
    };

    const result = await refreshValueTokenPriceFeedAndBuildCoreConfigParameters(
      parameters,
      {
        core: CORE,
        oracle: "0x5555555555555555555555555555555555555555",
        valueToken: ASSET,
        valueTokenPriceFeed: FEED,
      },
      {
        dryRun: false,
        feed,
        latestBlockTimestamp: 1_717_171_717n,
        waitForTransaction: async (pendingTx) => {
          waited.push(pendingTx);
          await pendingTx.wait();
        },
      },
    );

    expect(calls).to.deep.equal([[100_000_000n, 1_717_171_717n]]);
    expect(waited).to.deep.equal([refreshTx]);
    expect(result.FoundationCoreConfig).to.deep.equal({
      valueTokenMaxPriceAge: 86_400,
      valueTokenMinPrice: "900000000000000000",
      valueTokenMaxPrice: "1100000000000000000",
      core: CORE,
      oracle: "0x5555555555555555555555555555555555555555",
      valueToken: ASSET,
      valueTokenPriceFeed: FEED,
    });
  });

  it("does not mutate the feed during dry run", async function () {
    const calls: Array<[bigint, bigint]> = [];
    const waited: unknown[] = [];
    const feed = {
      setRoundData: async (answer: bigint, updatedAt: bigint) => {
        calls.push([answer, updatedAt]);
        return {
          hash: "0xrefresh",
          wait: async () => ({ status: 1 }),
        };
      },
    };

    await refreshValueTokenPriceFeedAndBuildCoreConfigParameters(
      {},
      {
        core: CORE,
        oracle: "0x5555555555555555555555555555555555555555",
        valueToken: ASSET,
        valueTokenPriceFeed: FEED,
      },
      {
        dryRun: true,
        feed,
        latestBlockTimestamp: 1_717_171_717n,
        waitForTransaction: async (pendingTx) => {
          waited.push(pendingTx);
          await pendingTx.wait();
        },
      },
    );

    expect(calls).to.deep.equal([]);
    expect(waited).to.deep.equal([]);
  });
});

function configureArgs(): string[] {
  return [
    "--core",
    CORE,
    "--asset",
    ASSET,
    "--feed",
    FEED,
    "--max-age",
    "86400",
    "--min-price",
    "950000000000000000",
    "--max-price",
    "1050000000000000000",
  ];
}
