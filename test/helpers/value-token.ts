export async function configureValueToken(
  ethers: any,
  core: any,
  asset: any,
  overrides: {
    decimals?: number;
    answer?: bigint | number | string;
    maxAge?: bigint | number | string;
    minPrice?: bigint | number | string;
    maxPrice?: bigint | number | string;
  } = {},
) {
  const assetAddress = typeof asset === "string" ? asset : await asset.getAddress();
  const decimals = overrides.decimals ?? 8;
  const answer = overrides.answer ?? 100000000n;
  const maxAge = overrides.maxAge ?? 86400n;
  const minPrice = overrides.minPrice ?? 900000000000000000n;
  const maxPrice = overrides.maxPrice ?? 1100000000000000000n;

  const feed = await ethers.deployContract("MockChainlinkAggregator", [decimals, answer]);

  const tx = await core.setValueTokenConfig(assetAddress, await feed.getAddress(), maxAge, minPrice, maxPrice);
  await tx.wait();

  return feed;
}
