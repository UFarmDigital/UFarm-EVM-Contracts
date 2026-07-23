import { expect } from "chai";
import {
  ethers,
  exactSelectorThenAny,
  deployAdapterFixture,
  OPCODE_BEGIN_STRUCT,
  OPCODE_DOMAIN,
  OPCODE_END_STRUCT,
  OPCODE_FIELD,
  VAULT_ASSET_MANAGER,
  addressWord,
  TYPE_ANY,
  TYPE_SELF,
  uintWord,
} from "../helpers/arbitrary-adapter";

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_INVALID_SIGNATURE = "0xffffffff";
const OracleFlow = {
  Active: 3n,
};

describe("ArbitraryAdapter", function () {
  it("rejects invalid guard addresses during deployment", async function () {
    const [, outsider] = await ethers.getSigners();
    const adapterFactory = await ethers.getContractFactory("ArbitraryAdapter");

    await expect(adapterFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      adapterFactory,
      "ArbitraryAdapterInvalidInput",
    );
    await expect(adapterFactory.deploy(outsider.address)).to.be.revertedWithCustomError(
      adapterFactory,
      "ArbitraryAdapterInvalidInput",
    );
  });

  it("executes a whitelisted target call through the vault adapter flow", async function () {
    const { core, vault, guard, adapter, targetDapp, adapterId, assetManager } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const payload = targetDapp.interface.encodeFunctionData("setValue", [42n]);
    const directive = exactSelectorThenAny(targetDapp.interface.getFunction("setValue").selector);
    const callData = adapter.interface.encodeFunctionData("performAction", [
      dapp,
      await targetDapp.getAddress(),
      payload,
      0n,
    ]);

    await core.setNavRequestCooldown(77n);
    await guard.whitelistProtocol(dapp, [await targetDapp.getAddress()], [directive]);

    const tx = await vault.connect(assetManager).executeAdapter(adapterId, callData);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    await expect(tx)
      .to.emit(targetDapp, "TargetCalled")
      .withArgs(await vault.getAddress(), 0n, 42n);
    await expect(tx).to.emit(vault, "AdapterExecuted").withArgs(adapterId);
    expect(await targetDapp.storedValue()).to.equal(42n);
    expect(await vault.settlementAllowedAt()).to.equal(BigInt(block!.timestamp) + 77n);

    const adapterLog = receipt!.logs
      .map((log) => {
        try {
          return adapter.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "ArbitraryActionExecuted");
    expect(adapterLog?.args.dapp).to.equal(dapp);
    expect(adapterLog?.args.target).to.equal(await targetDapp.getAddress());
  });

  it("rejects target calls that are not whitelisted", async function () {
    const { vault, adapter, targetDapp, adapterId, assetManager } = await deployAdapterFixture();
    const payload = targetDapp.interface.encodeFunctionData("setValue", [42n]);
    const callData = adapter.interface.encodeFunctionData("performAction", [
      ethers.id("MOCK_DAPP"),
      await targetDapp.getAddress(),
      payload,
      0n,
    ]);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      adapter,
      "ArbitraryAdapterCallNotAllowed",
    );
  });

  it("does not reuse a whitelisted selector for a different target", async function () {
    const { vault, guard, adapter, targetDapp, otherDapp, adapterId, assetManager } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const payload = targetDapp.interface.encodeFunctionData("setValue", [42n]);
    const directive = exactSelectorThenAny(targetDapp.interface.getFunction("setValue").selector);
    await guard.whitelistProtocol(dapp, [await targetDapp.getAddress()], [directive]);

    const callData = adapter.interface.encodeFunctionData("performAction", [
      dapp,
      await otherDapp.getAddress(),
      payload,
      0n,
    ]);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      adapter,
      "ArbitraryAdapterCallNotAllowed",
    );
  });

  it("rejects direct adapter calls", async function () {
    const { adapter, targetDapp } = await deployAdapterFixture();
    const payload = targetDapp.interface.encodeFunctionData("setValue", [42n]);

    await expect(
      adapter.performAction(ethers.id("MOCK_DAPP"), await targetDapp.getAddress(), payload, 0n),
    ).to.be.revertedWithCustomError(adapter, "ArbitraryAdapterDelegateCallOnly");
  });

  it("rejects invalid action inputs before guard lookup", async function () {
    const { vault, adapter, targetDapp, adapterId, assetManager } = await deployAdapterFixture();
    const payload = targetDapp.interface.encodeFunctionData("setValue", [42n]);

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          adapterId,
          adapter.interface.encodeFunctionData("performAction", [
            ethers.ZeroHash,
            await targetDapp.getAddress(),
            payload,
            0n,
          ]),
        ),
    ).to.be.revertedWithCustomError(adapter, "ArbitraryAdapterInvalidInput");

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          adapterId,
          adapter.interface.encodeFunctionData("performAction", [
            ethers.id("MOCK_DAPP"),
            ethers.ZeroAddress,
            payload,
            0n,
          ]),
        ),
    ).to.be.revertedWithCustomError(adapter, "ArbitraryAdapterInvalidInput");

    await expect(
      vault
        .connect(assetManager)
        .executeAdapter(
          adapterId,
          adapter.interface.encodeFunctionData("performAction", [
            ethers.id("MOCK_DAPP"),
            await targetDapp.getAddress(),
            "0x",
            0n,
          ]),
        ),
    ).to.be.revertedWithCustomError(adapter, "ArbitraryAdapterInvalidInput");
  });

  it("bubbles external target revert data", async function () {
    const { vault, guard, adapter, targetDapp, adapterId, assetManager } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const payload = targetDapp.interface.encodeFunctionData("fail", [7n]);
    const directive = exactSelectorThenAny(targetDapp.interface.getFunction("fail").selector);
    const callData = adapter.interface.encodeFunctionData("performAction", [
      dapp,
      await targetDapp.getAddress(),
      payload,
      0n,
    ]);
    await guard.whitelistProtocol(dapp, [await targetDapp.getAddress()], [directive]);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData))
      .to.be.revertedWithCustomError(targetDapp, "MockArbitraryDappFailed")
      .withArgs(7n);
  });

  it("reverts with adapter failure when the target reverts without data", async function () {
    const { vault, guard, adapter, adapterId, assetManager } = await deployAdapterFixture();
    const [deployer] = await ethers.getSigners();
    const emptyRevertFactory = new ethers.ContractFactory([], "0x625f5ffd5f526003601df3", deployer);
    const emptyRevertTarget = await emptyRevertFactory.deploy();
    await emptyRevertTarget.waitForDeployment();
    const dapp = ethers.id("EMPTY_REVERT_DAPP");
    const payload = "0x12345678";
    const directive = exactSelectorThenAny(payload);
    const callData = adapter.interface.encodeFunctionData("performAction", [
      dapp,
      await emptyRevertTarget.getAddress(),
      payload,
      0n,
    ]);
    await guard.whitelistProtocol(dapp, [await emptyRevertTarget.getAddress()], [directive]);

    await expect(vault.connect(assetManager).executeAdapter(adapterId, callData)).to.be.revertedWithCustomError(
      adapter,
      "ArbitraryAdapterExternalCallFailed",
    );
  });

  it("rejects zero dapp EIP-712 hash requests", async function () {
    const { adapter } = await deployAdapterFixture();

    await expect(
      adapter.eip712Hash(ethers.ZeroHash, ethers.concat([OPCODE_DOMAIN, ethers.ZeroHash])),
    ).to.be.revertedWithCustomError(adapter, "ArbitraryAdapterInvalidInput");
  });

  it("returns zero EIP-712 hash when the guard has no matching directive", async function () {
    const { adapter } = await deployAdapterFixture();
    const result = await adapter.eip712Hash.staticCall(
      ethers.id("MOCK_DAPP"),
      ethers.concat([OPCODE_DOMAIN, ethers.ZeroHash]),
    );

    expect(result).to.equal(ethers.ZeroHash);
  });

  it("returns configured EIP-712 hash as a view function", async function () {
    const { guard, adapter } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const domainSeparator = ethers.id("MOCK_DOMAIN");
    const typeHash = ethers.id("Order(uint256 amount)");
    const amount = uintWord(123n);
    const ops = ethers.concat([
      OPCODE_DOMAIN,
      domainSeparator,
      OPCODE_BEGIN_STRUCT,
      typeHash,
      OPCODE_FIELD,
      amount,
      OPCODE_END_STRUCT,
    ]);
    await guard.whitelistEIP712(dapp, domainSeparator, [
      { directives: [TYPE_ANY << 5, TYPE_ANY << 5], dictionary: "0x" },
    ]);

    const result = await adapter.eip712Hash.staticCall(dapp, ops);
    const rootHash = ethers.keccak256(ethers.concat([typeHash, amount]));
    expect(result).to.equal(ethers.keccak256(ethers.concat(["0x1901", domainSeparator, rootHash])));
  });

  it("lets an asset manager sign an EIP-712 digest and validates ERC-1271 signatures", async function () {
    const { core, curator, vault, vaultOwner, guard, adapter, assetManager, authority } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const domainSeparator = ethers.id("VAULT_SIGNING_DOMAIN");
    const typeHash = ethers.id("VaultAction(address vault,uint256 amount)");
    const vaultWord = addressWord(await vault.getAddress());
    const amount = uintWord(456n);
    const ops = ethers.concat([
      OPCODE_DOMAIN,
      domainSeparator,
      OPCODE_BEGIN_STRUCT,
      typeHash,
      OPCODE_FIELD,
      vaultWord,
      OPCODE_FIELD,
      amount,
      OPCODE_END_STRUCT,
    ]);
    await guard.whitelistEIP712(dapp, domainSeparator, [
      { directives: [TYPE_ANY << 5, TYPE_SELF << 5, TYPE_ANY << 5], dictionary: "0x" },
    ]);

    const rootHash = ethers.keccak256(ethers.concat([typeHash, vaultWord, amount]));
    const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, rootHash]));
    await vault.connect(assetManager).signMessage(dapp, ops);
    expect(await vault.signedMessages(digest)).to.equal(true);

    const signer = ethers.Wallet.createRandom();
    await vault.connect(vaultOwner).setPermissionMask(signer.address, (1n << 253n) | VAULT_ASSET_MANAGER);
    const signature = signer.signingKey.sign(digest).serialized;

    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await core.connect(authority).setGlobalPauseMask(1n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
    await expect(vault.connect(assetManager).signMessage(dapp, ops)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
    await core.connect(authority).setGlobalPauseMask(0n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 1n << 3n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
    await expect(vault.connect(assetManager).signMessage(dapp, ops)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
    await core.connect(authority).setCuratorPauseMask(await curator.getAddress(), 0n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await core.connect(authority).setGlobalPauseMask(1n << 7n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
    await expect(vault.connect(assetManager).signMessage(dapp, ops)).to.be.revertedWithCustomError(
      vault,
      "FlowPaused",
    );
    await core.connect(authority).setGlobalPauseMask(0n);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_MAGIC_VALUE);

    await vault.connect(assetManager).revokeSignedMessage(digest);
    expect(await vault.signedMessages(digest)).to.equal(false);
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
    expect(await adapter.eip712Hash(dapp, ops)).to.equal(ethers.ZeroHash);
  });

  it("rejects signing while an oracle request is active", async function () {
    const { core, vault, vaultOwner, guard, adapter, asset, assetManager, outsider } = await deployAdapterFixture();
    const oracle = await ethers.deployContract("MockUFarmOracle");
    const dapp = ethers.id("MOCK_DAPP");
    const domainSeparator = ethers.id("ACTIVE_ORACLE_SIGNING_DOMAIN");
    const typeHash = ethers.id("VaultAction(uint256 amount)");
    const amount = uintWord(123n);
    const ops = ethers.concat([
      OPCODE_DOMAIN,
      domainSeparator,
      OPCODE_BEGIN_STRUCT,
      typeHash,
      OPCODE_FIELD,
      amount,
      OPCODE_END_STRUCT,
    ]);
    await guard.whitelistEIP712(dapp, domainSeparator, [
      { directives: [TYPE_ANY << 5, TYPE_ANY << 5], dictionary: "0x" },
    ]);
    await core.setVaultOracle(await vault.getAddress(), await oracle.getAddress());

    await asset.mint(outsider.address, 100n);
    await asset.connect(outsider).approve(await vault.escrow(), 100n);
    await vault.connect(outsider).requestDeposit(100n, outsider.address, outsider.address);
    await vault.connect(vaultOwner).getFunction("settleRequests()")();

    await expect(vault.connect(assetManager).signMessage(dapp, ops))
      .to.be.revertedWithCustomError(vault, "OracleFlowError")
      .withArgs(OracleFlow.Active);
  });

  it("returns the ERC-1271 failure code for unsigned digests", async function () {
    const { vault } = await deployAdapterFixture();
    const signer = ethers.Wallet.createRandom();
    const digest = ethers.id("UNSIGNED_DIGEST");
    const signature = signer.signingKey.sign(digest).serialized;

    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
  });

  it("reverts signing when the adapter cannot authorize the message", async function () {
    const { vault, assetManager } = await deployAdapterFixture();
    const ops = ethers.concat([OPCODE_DOMAIN, ethers.id("UNCONFIGURED_DOMAIN")]);

    await expect(vault.connect(assetManager).signMessage(ethers.id("MOCK_DAPP"), ops))
      .to.be.revertedWithCustomError(vault, "Unauthorized")
      .withArgs(assetManager.address);
  });

  it("returns the ERC-1271 failure code when the recovered signer lacks asset manager permission", async function () {
    const { vault, guard, assetManager } = await deployAdapterFixture();
    const dapp = ethers.id("MOCK_DAPP");
    const domainSeparator = ethers.id("UNAUTHORIZED_SIGNER_DOMAIN");
    const typeHash = ethers.id("VaultAction(uint256 amount)");
    const amount = uintWord(789n);
    const ops = ethers.concat([
      OPCODE_DOMAIN,
      domainSeparator,
      OPCODE_BEGIN_STRUCT,
      typeHash,
      OPCODE_FIELD,
      amount,
      OPCODE_END_STRUCT,
    ]);
    await guard.whitelistEIP712(dapp, domainSeparator, [
      { directives: [TYPE_ANY << 5, TYPE_ANY << 5], dictionary: "0x" },
    ]);
    const rootHash = ethers.keccak256(ethers.concat([typeHash, amount]));
    const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, rootHash]));
    await vault.connect(assetManager).signMessage(dapp, ops);

    const signer = ethers.Wallet.createRandom();
    const signature = signer.signingKey.sign(digest).serialized;
    expect(await vault.isValidSignature(digest, signature)).to.equal(ERC1271_INVALID_SIGNATURE);
  });
});
