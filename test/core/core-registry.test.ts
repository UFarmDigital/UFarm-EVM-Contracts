import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

async function deployCore() {
  const [authority, other] = await ethers.getSigners();
  const { core } = await deployConfiguredCore(ethers, authority);
  return { core, authority, other };
}

describe("UFarmCore registry", function () {
  it("resolves vault oracle with address(0) wildcard fallback", async function () {
    const { core } = await deployCore();
    const vault = "0x0000000000000000000000000000000000000B01";
    const wildcardOracle = ethers.getAddress("0x0000000000000000000000000000000000000C01");
    const vaultOracle = ethers.getAddress("0x0000000000000000000000000000000000000C02");

    expect(await core.oracleForVault(vault)).to.equal(ethers.ZeroAddress);

    await core.setVaultOracle(ethers.ZeroAddress, wildcardOracle);
    expect(await core.oracleForVault(vault)).to.equal(wildcardOracle);

    await core.setVaultOracle(vault, vaultOracle);
    expect(await core.oracleForVault(vault)).to.equal(vaultOracle);

    await core.setVaultOracle(vault, ethers.ZeroAddress);
    expect(await core.oracleForVault(vault)).to.equal(wildcardOracle);
  });

  it("resolves per-vault protocol fees with explicit overrides and wildcard fallback", async function () {
    const { core } = await deployCore();
    const vault = "0x0000000000000000000000000000000000000B03";
    const oracle = ethers.getAddress("0x0000000000000000000000000000000000000C03");

    expect(await core.protocolFee(vault)).to.deep.equal([0n, false]);
    await core.setVaultOracle(vault, oracle);
    await core.setProtocolFee(ethers.ZeroAddress, 10n, true);
    expect(await core.protocolFee(vault)).to.deep.equal([10n, true]);
    expect(await core.oracleForVault(vault)).to.equal(oracle);

    await core.setProtocolFee(vault, 0n, false);
    expect(await core.protocolFee(vault)).to.deep.equal([0n, false]);
    expect(await core.oracleForVault(vault)).to.equal(oracle);

    await core.clearProtocolFee(vault);
    expect(await core.protocolFee(vault)).to.deep.equal([10n, true]);
    expect(await core.oracleForVault(vault)).to.equal(oracle);
  });

  it("resolves adapter by id and vault with address(0) wildcard fallback", async function () {
    const { core } = await deployCore();
    const adapterId = ethers.id("AAVE_V3_SUPPLY");
    const vault = "0x0000000000000000000000000000000000000B02";
    const wildcardAdapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("wildcard-adapter")]);
    const vaultAdapter = await ethers.deployContract("MockVaultAdapter", [ethers.id("vault-adapter")]);
    const wildcardAdapterAddress = await wildcardAdapter.getAddress();
    const vaultAdapterAddress = await vaultAdapter.getAddress();

    expect(await core.adapterForVault(adapterId, vault)).to.equal(ethers.ZeroAddress);

    await core.setVaultAdapter(adapterId, ethers.ZeroAddress, wildcardAdapterAddress);
    expect(await core.adapterForVault(adapterId, vault)).to.equal(wildcardAdapterAddress);

    await core.setVaultAdapter(adapterId, vault, vaultAdapterAddress);
    expect(await core.adapterForVault(adapterId, vault)).to.equal(vaultAdapterAddress);

    await core.setVaultAdapter(adapterId, vault, ethers.ZeroAddress);
    expect(await core.adapterForVault(adapterId, vault)).to.equal(wildcardAdapterAddress);
  });
});
