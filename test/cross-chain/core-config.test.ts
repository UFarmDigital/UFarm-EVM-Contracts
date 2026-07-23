import { expect } from "chai";
import { network } from "hardhat";
import { deployConfiguredCore } from "../helpers/deploy-core";

const { ethers } = await network.create();

const CORE_CONFIG_MANAGER = 1n << 1n;
const CROSS_CHAIN_ROUTER_PARAMETER = ethers.id("CROSS_CHAIN_ROUTER");
const CROSS_CHAIN_FEE_TOKEN_PARAMETER = ethers.id("CROSS_CHAIN_FEE_TOKEN");
const CROSS_CHAIN_TOKEN_PARAMETER = ethers.id("CROSS_CHAIN_TOKEN");
const CROSS_CHAIN_GAS_LIMIT_PARAMETER = ethers.id("CROSS_CHAIN_GAS_LIMIT");
const CoreConfig = {
  InvalidAccountingChain: 6n,
  InvalidCrossChainGasLimit: 7n,
  FactoryNotConfigured: 3n,
};

describe("UFarmCore cross-chain config", function () {
  it("sets accountingChainId via deploy helper and rejects second initializeCrossChain", async function () {
    const [authority] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority, { accountingChainId: 43114n });

    expect(await core.accountingChainId()).to.equal(43114n);
    await expect(core.initializeCrossChain(1n)).to.be.revertedWithCustomError(core, "InvalidInitialization");
  });

  it("rejects zero accountingChainId on fresh proxy initialized only with initialize(address)", async function () {
    const [authority] = await ethers.getSigners();

    const coreImpl = await ethers.deployContract("UFarmCore");
    const initData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
    const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), initData]);
    const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());

    await expect(core.initializeCrossChain(0n))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.InvalidAccountingChain);
  });

  it("rejects initializeCrossChain from non-owner on fresh proxy initialized only with initialize(address)", async function () {
    const [authority, nonOwner] = await ethers.getSigners();

    const coreImpl = await ethers.deployContract("UFarmCore");
    const initData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
    const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), initData]);
    const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());

    await expect(core.connect(nonOwner).initializeCrossChain(31337n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(nonOwner.address);
  });

  it("rejects initializeCrossChain from owner before initializeFactory on fresh proxy", async function () {
    const [authority] = await ethers.getSigners();

    const coreImpl = await ethers.deployContract("UFarmCore");
    const initData = coreImpl.interface.encodeFunctionData("initialize", [authority.address]);
    const coreProxy = await ethers.deployContract("ERC1967Proxy", [await coreImpl.getAddress(), initData]);
    const core = await ethers.getContractAt("UFarmCore", await coreProxy.getAddress());

    await expect(core.initializeCrossChain(31337n))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.FactoryNotConfigured);
  });

  it("requires CORE_CONFIG_MANAGER for mutable config and stores router feeToken gasLimit selector", async function () {
    const [authority, operator] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);
    const router = ethers.getAddress("0x0000000000000000000000000000000000000c01");
    const feeToken = ethers.getAddress("0x0000000000000000000000000000000000000f01");
    const crossChainToken = ethers.getAddress("0x0000000000000000000000000000000000000c02");

    await expect(core.connect(operator).setCrossChainRouter(router))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(operator.address);
    await expect(core.connect(operator).setCrossChainFeeToken(feeToken))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(operator.address);
    await expect(core.connect(operator).setCrossChainToken(crossChainToken))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(operator.address);
    await expect(core.connect(operator).setCrossChainGasLimit(500_000n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(operator.address);
    await expect(core.connect(operator).setCCIPSelector(42161n, 4949039107694359620n))
      .to.be.revertedWithCustomError(core, "Unauthorized")
      .withArgs(operator.address);

    await core.setPermissionMask(operator.address, (1n << 253n) | CORE_CONFIG_MANAGER);

    await expect(core.connect(operator).setCrossChainRouter(router))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(CROSS_CHAIN_ROUTER_PARAMETER, BigInt(router));
    await expect(core.connect(operator).setCrossChainFeeToken(feeToken))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(CROSS_CHAIN_FEE_TOKEN_PARAMETER, BigInt(feeToken));
    await expect(core.connect(operator).setCrossChainToken(crossChainToken))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(CROSS_CHAIN_TOKEN_PARAMETER, BigInt(crossChainToken));
    await expect(core.connect(operator).setCrossChainGasLimit(500_000n))
      .to.emit(core, "CoreParameterUpdated")
      .withArgs(CROSS_CHAIN_GAS_LIMIT_PARAMETER, 500_000n);
    await expect(core.connect(operator).setCCIPSelector(42161n, 4949039107694359620n))
      .to.emit(core, "CCIPSelectorUpdated")
      .withArgs(42161n, 4949039107694359620n);

    expect(await core.crossChainRouter()).to.equal(router);
    expect(await core.crossChainFeeToken()).to.equal(feeToken);
    expect(await core.crossChainToken()).to.equal(crossChainToken);
    expect(await core.crossChainGasLimit()).to.equal(500_000n);
    expect(await core.ccipSelectorForChain(42161n)).to.equal(4949039107694359620n);
  });

  it("rejects zero cross-chain gas limit and zero selector chain id", async function () {
    const [authority, operator] = await ethers.getSigners();
    const { core } = await deployConfiguredCore(ethers, authority);

    await core.setPermissionMask(operator.address, (1n << 253n) | CORE_CONFIG_MANAGER);

    await expect(core.connect(operator).setCrossChainGasLimit(0n))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.InvalidCrossChainGasLimit);
    await expect(core.connect(operator).setCCIPSelector(0n, 1n))
      .to.be.revertedWithCustomError(core, "CoreConfigError")
      .withArgs(CoreConfig.InvalidAccountingChain);
  });
});
