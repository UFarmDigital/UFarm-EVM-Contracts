import { expect } from "chai";
import {
  CORE_ADAPTER_MANAGER,
  OPCODE_BEGIN_ARRAY,
  OPCODE_BEGIN_STRUCT,
  OPCODE_DOMAIN,
  OPCODE_END_ARRAY,
  OPCODE_END_STRUCT,
  OPCODE_FIELD,
  TYPE_ANY,
  TYPE_EXACT,
  TYPE_FROM_LIST,
  TYPE_SELF,
  TYPE_WILDCARD_BYTES,
  TYPE_WILDCARD_WORDS,
  addressWord,
  createCalldata,
  deployGuardFixture,
  encodeDirective,
  ethers,
  exactSelectorDirective,
  randomHex,
  selector,
  uintWord,
} from "../helpers/arbitrary-adapter";

const DAPP_ID = ethers.encodeBytes32String("DAPP");
const OTHER_DAPP_ID = ethers.encodeBytes32String("OTHER_DAPP");

function exactHeader(index: number) {
  return (TYPE_EXACT << 5) | index;
}

function buildExactSignDirective(words: string[]) {
  return {
    directives: words.map((_, index) => exactHeader(index)),
    dictionary: ethers.concat(words),
  };
}

function buildTypedExactSignDirective(typeHash: string, words: string[]) {
  return buildExactSignDirective([typeHash, ...words]);
}

function buildOps(fields: string[], domainSeparator: string, typeHash: string) {
  return ethers.concat([
    OPCODE_DOMAIN,
    domainSeparator,
    OPCODE_BEGIN_STRUCT,
    typeHash,
    ...fields.flatMap((field) => [OPCODE_FIELD, field]),
    OPCODE_END_STRUCT,
  ]);
}

function buildNestedOps(toField: string, refField: string, amountField: string, domainSeparator: string) {
  const outerTypeHash = ethers.id("Outer(address to,Inner inner)Inner(address ref,uint256 amount)");
  const innerTypeHash = ethers.id("Inner(address ref,uint256 amount)");
  return ethers.concat([
    OPCODE_DOMAIN,
    domainSeparator,
    OPCODE_BEGIN_STRUCT,
    outerTypeHash,
    OPCODE_FIELD,
    toField,
    OPCODE_BEGIN_STRUCT,
    innerTypeHash,
    OPCODE_FIELD,
    refField,
    OPCODE_FIELD,
    amountField,
    OPCODE_END_STRUCT,
    OPCODE_END_STRUCT,
  ]);
}

function buildArrayOps(elements: string[], domainSeparator: string, typeHash: string) {
  return ethers.concat([
    OPCODE_DOMAIN,
    domainSeparator,
    OPCODE_BEGIN_STRUCT,
    typeHash,
    OPCODE_BEGIN_ARRAY,
    ...elements.flatMap((element) => [OPCODE_FIELD, element]),
    OPCODE_END_ARRAY,
    OPCODE_END_STRUCT,
  ]);
}

function buildStructArrayOps(items: Array<[string, string]>, domainSeparator: string) {
  const outerTypeHash = ethers.id("ArrayOfStructs(Inner[] items)Inner(address ref,uint256 amount)");
  const innerTypeHash = ethers.id("Inner(address ref,uint256 amount)");
  return ethers.concat([
    OPCODE_DOMAIN,
    domainSeparator,
    OPCODE_BEGIN_STRUCT,
    outerTypeHash,
    OPCODE_BEGIN_ARRAY,
    ...items.flatMap(([refWord, amountWord]) => [
      OPCODE_BEGIN_STRUCT,
      innerTypeHash,
      OPCODE_FIELD,
      refWord,
      OPCODE_FIELD,
      amountWord,
      OPCODE_END_STRUCT,
    ]),
    OPCODE_END_ARRAY,
    OPCODE_END_STRUCT,
  ]);
}

async function whitelistAddressInDapp(guard: any, address: string, dapp = DAPP_ID) {
  await guard.whitelistProtocol(dapp, [address], [exactSelectorDirective("0x11111111")]);
}

describe("ArbitraryAdapterGuard", function () {
  describe("permissions and whitelist lifecycle", function () {
    it("rejects invalid core addresses during deployment", async function () {
      const [, , outsider] = await ethers.getSigners();
      const guardFactory = await ethers.getContractFactory("ArbitraryAdapterGuard");

      await expect(guardFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        guardFactory,
        "ArbitraryAdapterGuardInvalidInput",
      );
      await expect(guardFactory.deploy(outsider.address)).to.be.revertedWithCustomError(
        guardFactory,
        "ArbitraryAdapterGuardInvalidInput",
      );
    });

    it("requires core adapter manager permission to update protocol directives", async function () {
      const { core, guard, manager, outsider, target } = await deployGuardFixture();
      const method = selector("swapExactTokensForTokens(uint256)");
      const directive = exactSelectorDirective(method);

      await expect(guard.connect(outsider).whitelistProtocol(DAPP_ID, [target.address], [directive]))
        .to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(outsider.address);

      await core.setPermissionMask(outsider.address, CORE_ADAPTER_MANAGER);
      await expect(guard.connect(outsider).whitelistProtocol(DAPP_ID, [target.address], [directive]))
        .to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(outsider.address);

      await expect(guard.connect(manager).whitelistProtocol(DAPP_ID, [target.address], [directive]))
        .to.emit(guard, "ArbitraryAdapterWhitelistUpdated")
        .withArgs(DAPP_ID, target.address, method, true);

      await core.setPermissionMask(manager.address, 0n);
      await expect(guard.connect(manager).unwhitelistProtocol(DAPP_ID, target.address, [0n]))
        .to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(manager.address);

      await core.setPermissionMask(manager.address, (1n << 253n) | CORE_ADAPTER_MANAGER);
      await expect(guard.connect(manager).unwhitelistProtocol(DAPP_ID, target.address, [0n]))
        .to.emit(guard, "ArbitraryAdapterWhitelistUpdated")
        .withArgs(DAPP_ID, target.address, method, false);
    });

    it("authorizes proxied upgrades only for the core owner", async function () {
      const { core, authority, manager, outsider } = await deployGuardFixture();
      const implementation = await ethers.deployContract("ArbitraryAdapterGuard", [await core.getAddress()]);
      const initData = implementation.interface.encodeFunctionData("initialize");
      const proxy = await ethers.deployContract("ERC1967Proxy", [await implementation.getAddress(), initData]);
      const proxiedGuard = await ethers.getContractAt("ArbitraryAdapterGuard", await proxy.getAddress());
      const nextImplementation = await ethers.deployContract("ArbitraryAdapterGuard", [await core.getAddress()]);

      await expect(proxiedGuard.connect(outsider).upgradeToAndCall(await nextImplementation.getAddress(), "0x"))
        .to.be.revertedWithCustomError(proxiedGuard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(outsider.address);
      await expect(proxiedGuard.connect(manager).upgradeToAndCall(await nextImplementation.getAddress(), "0x"))
        .to.be.revertedWithCustomError(proxiedGuard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(manager.address);

      await expect(proxiedGuard.connect(authority).upgradeToAndCall(await nextImplementation.getAddress(), "0x"))
        .to.emit(proxiedGuard, "Upgraded")
        .withArgs(await nextImplementation.getAddress());
    });

    it("returns false before whitelisting and for the same selector on a different target", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("approve(address,uint256)");
      const payload = createCalldata(method, [other.address, uintWord(1n)]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, payload)).to.equal(false);

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [exactSelectorDirective(method)]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, other.address, method)).to.equal(false);
    });

    it("rejects invalid whitelist inputs and out-of-bounds removals", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("foo()");

      await expect(
        guard.connect(manager).whitelistProtocol(ethers.ZeroHash, [user.address], [exactSelectorDirective(method)]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [], [exactSelectorDirective(method)]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [])).to.be.revertedWithCustomError(
        guard,
        "ArbitraryAdapterGuardInvalidInput",
      );
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [ethers.ZeroAddress], [exactSelectorDirective(method)]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], ["0x12"]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidSelector");
      await expect(guard.connect(manager).unwhitelistProtocol(DAPP_ID, user.address, [])).to.be.revertedWithCustomError(
        guard,
        "ArbitraryAdapterGuardInvalidInput",
      );
      await expect(
        guard.connect(manager).unwhitelistProtocol(DAPP_ID, user.address, [0n]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardIndexOutOfBounds");
    });

    it("removes multiple protocol whitelist directives by sequential indexes", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const first = selector("first()");
      const second = selector("second()");
      await guard
        .connect(manager)
        .whitelistProtocol(DAPP_ID, [user.address], [exactSelectorDirective(first), exactSelectorDirective(second)]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, first)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, second)).to.equal(true);

      await guard.connect(manager).unwhitelistProtocol(DAPP_ID, user.address, [1n, 0n]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, first)).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, second)).to.equal(false);
    });
  });

  describe("payload directives", function () {
    it("matches exact selectors and exact constant arguments", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("withConst(uint256)");
      const expected = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: expected },
      ]);

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(42n)]))).to.equal(
        true,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        false,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, "0xbe"]))).to.equal(false);
    });

    it("matches word wildcards and keeps later exact checks", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("pair(uint256,uint256)");
      const tail = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_EXACT, span: 32, data: tail },
      ]);

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);

      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(1n), tail])),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(1n), uintWord(43n)])),
      ).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(false);
    });

    it("allows any trailing payload only when TYPE_ANY is the final segment", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("prefixed(bytes)");
      const prefix = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: prefix },
        { typ: TYPE_ANY, span: 1 },
      ]);
      const invalidDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
        { typ: TYPE_EXACT, span: 1, data: "0x12" },
      ]);

      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [invalidDirective]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, prefix]))).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, prefix, randomHex(96)])),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, uintWord(43n), randomHex(32)])),
      ).to.equal(false);
    });

    it("matches TYPE_SELF for packed and ABI-padded addresses", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const packedMethod = selector("setOwner(address)");
      const paddedMethod = selector("authorize(address)");
      await guard.connect(manager).whitelistProtocol(
        DAPP_ID,
        [other.address],
        [
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: packedMethod },
            { typ: TYPE_SELF, span: 20 },
          ]),
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: paddedMethod },
            { typ: TYPE_SELF, span: 32 },
          ]),
        ],
      );

      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, other.address, ethers.concat([packedMethod, user.address])),
      ).to.equal(true);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, other.address, ethers.concat([packedMethod, other.address])),
      ).to.equal(false);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, other.address, createCalldata(paddedMethod, [user.address])),
      ).to.equal(true);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, other.address, createCalldata(paddedMethod, [other.address])),
      ).to.equal(false);
    });

    it("rejects invalid TYPE_SELF and TYPE_FROM_LIST spans", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      await expect(
        guard.connect(manager).whitelistProtocol(
          DAPP_ID,
          [user.address],
          [
            encodeDirective([
              { typ: TYPE_EXACT, span: 4, data: selector("badSelf()") },
              { typ: TYPE_SELF, span: 19 },
            ]),
          ],
        ),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");

      await expect(
        guard.connect(manager).whitelistProtocol(
          DAPP_ID,
          [user.address],
          [
            encodeDirective([
              { typ: TYPE_EXACT, span: 4, data: selector("badList()") },
              { typ: TYPE_FROM_LIST, span: 33 },
            ]),
          ],
        ),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("matches TYPE_FROM_LIST only for addresses whitelisted under the same dapp", async function () {
      const { guard, manager, user, other, target } = await deployGuardFixture();
      const method = selector("route(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address, DAPP_ID);
      await whitelistAddressInDapp(guard.connect(manager), target.address, OTHER_DAPP_ID);
      await guard.connect(manager).whitelistProtocol(
        DAPP_ID,
        [user.address],
        [
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: method },
            { typ: TYPE_FROM_LIST, span: 32 },
          ]),
        ],
      );

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address]))).to.equal(
        true,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [target.address]))).to.equal(
        false,
      );

      await guard.connect(manager).unwhitelistProtocol(DAPP_ID, other.address, [0n]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address]))).to.equal(
        false,
      );
    });

    it("matches byte wildcards without word alignment", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("skipThenExact(bytes)");
      const tail = "0xdeadbeef";
      const bytesDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 31 },
        { typ: TYPE_EXACT, span: 1, data: "0xaa" },
      ]);
      const wordsDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_EXACT, span: 1, data: "0xaa" },
      ]);
      const exactAfterBytes = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 5 },
        { typ: TYPE_EXACT, span: 4, data: tail },
      ]);

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [bytesDirective, exactAfterBytes]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [other.address], [wordsDirective]);

      const thirtyOne = randomHex(31);
      const alignedPayload = ethers.concat([method, thirtyOne, "0xaa"]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, alignedPayload)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, other.address, alignedPayload)).to.equal(false);

      const skipped = randomHex(5);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, skipped, tail]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, skipped, "0xdeadbeee"])),
      ).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, randomHex(3)]))).to.equal(
        false,
      );
    });

    it("allows any matching directive and returns false when none match", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("multiAllow(uint256)");
      const exact42 = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);
      const wildcard = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      const noMatchMethod = selector("noMatch(uint256)");
      const noMatch = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: noMatchMethod },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);

      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [exact42, wildcard, noMatch]);

      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(42n)]))).to.equal(
        true,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(noMatchMethod, [uintWord(43n)])),
      ).to.equal(false);
    });
  });

  describe("legacy Guard2 payload parity", function () {
    it("allows exact selector match", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("foo()");
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [exactSelectorDirective(method)]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(true);
    });

    it("allows fixed wildcard word skipping one argument", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("foo(uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n)])),
      ).to.equal(true);
    });

    it("allows any-length wildcard when it is last", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("log(bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n)])),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0x1234n), uintWord(0x5678n)]),
        ),
      ).to.equal(true);
    });

    it("allows match when argument equals msg.sender", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("setOwner(address)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [other.address], [directive]);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, other.address, createCalldata(method, [user.address])),
      ).to.equal(true);
    });

    it("allows match when argument is whitelisted address", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("depositTo(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_FROM_LIST, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address]))).to.equal(
        true,
      );
    });

    it("TYPE_WILDCARD_WORDS: skip 1 word accepts any 32-byte value", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("foo(uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(1n)]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n)])),
      ).to.equal(true);
    });

    it("TYPE_WILDCARD_WORDS: skip 2 words accepts any two 32-byte args", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("bar(uint256,uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 2 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0xdeadbeefn), uintWord(0xcafen)]),
        ),
      ).to.equal(true);
    });

    it("TYPE_WILDCARD_WORDS: skip 1 word but payload too short", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("short(uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(false);
    });

    it("TYPE_WILDCARD_WORDS + TYPE_EXACT: skip first arg, enforce second exact 32B", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("pair(uint256,uint256)");
      const exactValue = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_EXACT, span: 32, data: exactValue },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n), exactValue])),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0x1234n), uintWord(43n)]),
        ),
      ).to.equal(false);
    });

    it("TYPE_WILDCARD_WORDS + TYPE_SELF: skip first arg, then require msg.sender", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("op(uint256,address)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_SELF, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n), user.address])),
      ).to.equal(true);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(0x1234n), other.address])),
      ).to.equal(false);
    });

    it("TYPE_WILDCARD_WORDS + TYPE_FROM_LIST: skip first arg, then require whitelisted address", async function () {
      const { guard, manager, user, other, target } = await deployGuardFixture();
      const method = selector("route(uint256,address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_FROM_LIST, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0x1234n), other.address]),
        ),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0x1234n), target.address]),
        ),
      ).to.equal(false);
    });

    it("TYPE_ANY: appears last and allows any trailing payload including zero bytes", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("anyTail()");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(1n)]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(
          DAPP_ID,
          user.address,
          createCalldata(method, [uintWord(0xdeadn), uintWord(0xbeefn)]),
        ),
      ).to.equal(true);
    });

    it("TYPE_ANY: not last reverts during whitelist setup", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("badLayout()");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
        { typ: TYPE_EXACT, span: 1, data: "0x12" },
      ]);
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("TYPE_ANY: after selector and fixed exact prefix accepts trailing variable payload", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("prefixed(bytes)");
      const exact32 = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: exact32 },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, exact32]))).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, exact32, randomHex(64)])),
      ).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, uintWord(43n), "0x1234"])),
      ).to.equal(false);
    });

    it("TYPE_ANY: structured prefix with multiple exact chunks and ANY tail", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("structuredTail()");
      const constA = "0x11223344";
      const constB = "0xaabbccdd";
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 4, data: constA },
        { typ: TYPE_EXACT, span: 4, data: constB },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const base = ethers.concat([method, constA, constB]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, base)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([base, "0xdeadbeef"]))).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([base, randomHex(100)]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, constA, "0x00000000"])),
      ).to.equal(false);
    });

    it("TYPE_ANY: accepts very long tails", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("longTail(bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, randomHex(4096)]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, uintWord(1024n), randomHex(1024)])),
      ).to.equal(true);
    });

    it("TYPE_SELF: 20-byte comparison against msg.sender", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("setOwner(address)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 20 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, user.address])),
      ).to.equal(true);
    });

    it("TYPE_SELF: 32-byte word-padded comparison against msg.sender", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("authorize(address)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [user.address])),
      ).to.equal(true);
    });

    it("TYPE_SELF: mismatch address vs msg.sender returns false for 20B and 32B", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method20 = selector("setOwner(address)");
      const method32 = selector("authorize(address)");
      await guard.connect(manager).whitelistProtocol(
        DAPP_ID,
        [user.address],
        [
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: method20 },
            { typ: TYPE_SELF, span: 20 },
          ]),
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: method32 },
            { typ: TYPE_SELF, span: 32 },
          ]),
        ],
      );
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method20, other.address])),
      ).to.equal(false);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, createCalldata(method32, [other.address])),
      ).to.equal(false);
    });

    it("TYPE_SELF: invalid span below 20 is rejected", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector("selfBadSpan()") },
        { typ: TYPE_SELF, span: 19 },
      ]);
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("TYPE_SELF: invalid span above 32 is rejected", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector("selfBadSpan2()") },
        { typ: TYPE_SELF, span: 33 },
      ]);
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("TYPE_SELF: exact selector then SELF 20B then ANY", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("pipe(address,bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 20 },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, user.address, randomHex(64)])),
      ).to.equal(true);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, other.address, randomHex(16)])),
      ).to.equal(false);
    });

    it("TYPE_SELF: exact selector then SELF 32B then ANY", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("pipePadded(address,bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 32 },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const ok = createCalldata(method, [user.address]);
      expect(await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, ok)).to.equal(true);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address])),
      ).to.equal(false);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, ethers.concat([ok, randomHex(96)])),
      ).to.equal(true);
    });

    it("TYPE_FROM_LIST: 20-byte whitelisted address matches", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("route(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_FROM_LIST, span: 20 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, other.address]))).to.equal(
        true,
      );
    });

    it("TYPE_FROM_LIST: 32-byte whitelisted address matches", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("routePad(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_FROM_LIST, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address]))).to.equal(
        true,
      );
    });

    it("TYPE_FROM_LIST: non-whitelisted address returns false for 20B and 32B", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method20 = selector("x(address)");
      const method32 = selector("y(address)");
      await guard.connect(manager).whitelistProtocol(
        DAPP_ID,
        [user.address],
        [
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: method20 },
            { typ: TYPE_FROM_LIST, span: 20 },
          ]),
          encodeDirective([
            { typ: TYPE_EXACT, span: 4, data: method32 },
            { typ: TYPE_FROM_LIST, span: 32 },
          ]),
        ],
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method20, other.address]))).to.equal(
        false,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method32, [other.address]))).to.equal(
        false,
      );
    });

    it("TYPE_FROM_LIST: becomes false after referenced address is unwhitelisted", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("useWL(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_FROM_LIST, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const payload = createCalldata(method, [other.address]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, payload)).to.equal(true);
      await guard.connect(manager).unwhitelistProtocol(DAPP_ID, other.address, [0n]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, payload)).to.equal(false);
    });

    it("TYPE_FROM_LIST: whitelisted in another dapp does not count", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("cross(address)");
      await whitelistAddressInDapp(guard.connect(manager), other.address, OTHER_DAPP_ID);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_FROM_LIST, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [other.address]))).to.equal(
        false,
      );
    });

    it("TYPE_EXACT: matches 4-byte selector", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("onlySelector()");
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [exactSelectorDirective(method)]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, method)).to.equal(true);
    });

    it("TYPE_EXACT: matches 32-byte constant argument after selector", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("withConst(uint256)");
      const value = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: value },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [value]))).to.equal(true);
    });

    it("TYPE_EXACT: one byte mismatch returns false", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("withConst(uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        false,
      );
    });

    it("TYPE_EXACT: payload too short returns false", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("needsTwoBytes()");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 2, data: "0xbeef" },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, "0xbe"]))).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, "0xbeef"]))).to.equal(true);
    });

    it("TYPE_EXACT: multiple exact segments in sequence must all match", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("multiExact()");
      const a = "0x11223344";
      const b = "0xaabbccdd";
      const c = uintWord(42n);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 4, data: a },
        { typ: TYPE_EXACT, span: 4, data: b },
        { typ: TYPE_EXACT, span: 32, data: c },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, a, b, c]))).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, a, "0xaabbccde", c])),
      ).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, a, b]))).to.equal(false);
    });

    it("TYPE_WILDCARD_BYTES: skip 1 byte", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("oneByte(bytes1)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, randomHex(1)]))).to.equal(
        true,
      );
    });

    it("TYPE_WILDCARD_BYTES: skip arbitrary byte counts 5, 13, and 31", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("skipN(bytes)");
      for (const n of [5, 13, 31]) {
        const directive = encodeDirective([
          { typ: TYPE_EXACT, span: 4, data: method },
          { typ: TYPE_WILDCARD_BYTES, span: n },
        ]);
        await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
        expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, randomHex(n)]))).to.equal(
          true,
        );
      }
    });

    it("TYPE_WILDCARD_BYTES: returns false when skipping more bytes than payload has", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("short(bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 5 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, randomHex(3)]))).to.equal(
        false,
      );
    });

    it("TYPE_WILDCARD_BYTES + TYPE_EXACT: skip N bytes then enforce trailing constant", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("skipThenExact(bytes)");
      const tail = "0xdeadbeef";
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 5 },
        { typ: TYPE_EXACT, span: 4, data: tail },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const skipped = randomHex(5);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, skipped, tail]))).to.equal(
        true,
      );
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, skipped, "0xdeadbeee"])),
      ).to.equal(false);
    });

    it("TYPE_WILDCARD_BYTES vs TYPE_WILDCARD_WORDS: byte alignment differs", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("align(bytes)");
      const lastByte = "0xaa";
      const bytesDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 31 },
        { typ: TYPE_EXACT, span: 1, data: lastByte },
      ]);
      const wordsDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
        { typ: TYPE_EXACT, span: 1, data: lastByte },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [bytesDirective]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [other.address], [wordsDirective]);
      const payload = ethers.concat([method, randomHex(31), lastByte]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, payload)).to.equal(true);
      expect(await guard.isProtocolAllowed(DAPP_ID, other.address, payload)).to.equal(false);
    });

    it("Integration: EXACT then WILDCARD_WORDS(2) then EXACT constant", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("mixA(uint256,uint256)");
      const tail = "0xdeadbeef";
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 2 },
        { typ: TYPE_EXACT, span: 4, data: tail },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const words = ethers.concat([randomHex(32), randomHex(32)]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, words, tail]))).to.equal(true);
      expect(
        await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, words, "0xdeadbeee"])),
      ).to.equal(false);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, words]))).to.equal(false);
    });

    it("Integration: EXACT then WILDCARD_BYTES(5) then SELF(32)", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("mixB(bytes5,address)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_BYTES, span: 5 },
        { typ: TYPE_SELF, span: 32 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      const five = randomHex(5);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, five, addressWord(user.address)])),
      ).to.equal(true);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, five, addressWord(other.address)])),
      ).to.equal(false);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, "0x00", addressWord(user.address)])),
      ).to.equal(false);
    });

    it("Integration: EXACT then SELF(20) then ANY", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const method = selector("mixC(address,bytes)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_SELF, span: 20 },
        { typ: TYPE_ANY, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(
        await guard
          .connect(user)
          .isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, user.address, randomHex(64)])),
      ).to.equal(true);
      expect(
        await guard.connect(user).isProtocolAllowed(DAPP_ID, user.address, ethers.concat([method, other.address])),
      ).to.equal(false);
    });

    it("Integration: EXACT then ANY then EXACT constant is invalid", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("invalidAnyThenExact()");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_ANY, span: 1 },
        { typ: TYPE_EXACT, span: 4, data: "0x01020304" },
      ]);
      await expect(
        guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("Integration: multiple directives for same selector allow any matching one", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("multiAllow(uint256)");
      const dirA = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);
      const dirB = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [dirA, dirB]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(42n)]))).to.equal(
        true,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        true,
      );
    });

    it("Integration: multiple possible matches still allow first valid directive", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("firstWins(uint256)");
      const first = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);
      const second = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_WILDCARD_WORDS, span: 1 },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [first, second]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(42n)]))).to.equal(
        true,
      );
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        true,
      );
    });

    it("Integration: when no directive matches returns false", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const method = selector("noMatch(uint256)");
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: method },
        { typ: TYPE_EXACT, span: 32, data: uintWord(42n) },
      ]);
      await guard.connect(manager).whitelistProtocol(DAPP_ID, [user.address], [directive]);
      expect(await guard.isProtocolAllowed(DAPP_ID, user.address, createCalldata(method, [uintWord(43n)]))).to.equal(
        false,
      );
    });
  });

  describe("EIP-712 directives", function () {
    const DOMAIN_SEPARATOR = ethers.id("GUARD_EIP712");
    const REQUEST_TYPEHASH = ethers.id("Request(address to,uint256 amount)");
    const INNER_TYPEHASH = ethers.id("Inner(address ref,uint256 amount)");
    const OUTER_TYPEHASH = ethers.id("Outer(address to,Inner inner)Inner(address ref,uint256 amount)");
    const ARRAY_TYPEHASH = ethers.id("ArrayHolder(uint256[] nums)");
    const ARRAY_STRUCT_TYPEHASH = ethers.id("ArrayOfStructs(Inner[] items)Inner(address ref,uint256 amount)");
    const MIXED_TYPEHASH = ethers.id("Mixed(bytes32 random,address actor,address target)");

    it("rejects invalid EIP-712 whitelist inputs and directive headers", async function () {
      const { guard, manager } = await deployGuardFixture();

      await expect(
        guard
          .connect(manager)
          .whitelistEIP712(ethers.ZeroHash, DOMAIN_SEPARATOR, [{ directives: [TYPE_ANY << 5], dictionary: "0x" }]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard
          .connect(manager)
          .whitelistEIP712(DAPP_ID, ethers.ZeroHash, [{ directives: [TYPE_ANY << 5], dictionary: "0x" }]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [])).to.be.revertedWithCustomError(
        guard,
        "ArbitraryAdapterGuardInvalidInput",
      );
      await expect(
        guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [{ directives: [], dictionary: "0x" }]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard
          .connect(manager)
          .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [{ directives: [TYPE_WILDCARD_BYTES << 5], dictionary: "0x" }]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard
          .connect(manager)
          .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
            { directives: [(TYPE_EXACT << 5) | 1], dictionary: REQUEST_TYPEHASH },
          ]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard
          .connect(manager)
          .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [{ directives: [(TYPE_ANY << 5) | 1], dictionary: "0x" }]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, []),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [0n]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardIndexOutOfBounds");
    });

    it("rejects malformed EIP-712 operation streams", async function () {
      const { guard, manager } = await deployGuardFixture();
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [{ directives: [TYPE_ANY << 5, TYPE_ANY << 5], dictionary: "0x" }]);

      await expect(guard.eip712Hash(DAPP_ID, "0x")).to.be.revertedWithCustomError(
        guard,
        "ArbitraryAdapterGuardInvalidInput",
      );
      await expect(
        guard.eip712Hash(DAPP_ID, ethers.concat([OPCODE_FIELD, DOMAIN_SEPARATOR])),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.eip712Hash(DAPP_ID, ethers.concat([OPCODE_DOMAIN, DOMAIN_SEPARATOR, OPCODE_FIELD, uintWord(1n)])),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.eip712Hash(
          DAPP_ID,
          ethers.concat([OPCODE_DOMAIN, DOMAIN_SEPARATOR, OPCODE_BEGIN_STRUCT, REQUEST_TYPEHASH, OPCODE_END_ARRAY]),
        ),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
      await expect(
        guard.eip712Hash(
          DAPP_ID,
          ethers.concat([
            OPCODE_DOMAIN,
            DOMAIN_SEPARATOR,
            OPCODE_BEGIN_STRUCT,
            REQUEST_TYPEHASH,
            OPCODE_END_STRUCT,
            OPCODE_BEGIN_STRUCT,
            REQUEST_TYPEHASH,
            OPCODE_END_STRUCT,
          ]),
        ),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardInvalidInput");
    });

    it("rejects forged struct typehash when field values match whitelisted directives", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const toWord = addressWord(user.address);
      const amountWord = uintWord(42n);
      const forgedTypeHash = ethers.id("ForgedRequest(address to,uint256 amount)");
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
          buildTypedExactSignDirective(REQUEST_TYPEHASH, [toWord, amountWord]),
        ]);

      const honest = await guard.eip712Hash(
        DAPP_ID,
        buildOps([toWord, amountWord], DOMAIN_SEPARATOR, REQUEST_TYPEHASH),
      );
      const forged = await guard.eip712Hash(DAPP_ID, buildOps([toWord, amountWord], DOMAIN_SEPARATOR, forgedTypeHash));

      expect(honest).to.not.equal(ethers.ZeroHash);
      expect(forged).to.equal(ethers.ZeroHash);
    });

    it("does not let a payload value occupy the directive slot reserved for the struct typehash", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      await guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
        {
          directives: [TYPE_ANY << 5, TYPE_ANY << 5, TYPE_SELF << 5],
          dictionary: "0x",
        },
      ]);

      const honest = await guard
        .connect(user)
        .eip712Hash(DAPP_ID, buildOps([uintWord(1n), addressWord(user.address)], DOMAIN_SEPARATOR, REQUEST_TYPEHASH));
      const forged = await guard
        .connect(user)
        .eip712Hash(DAPP_ID, buildOps([uintWord(1n), addressWord(other.address)], DOMAIN_SEPARATOR, REQUEST_TYPEHASH));

      expect(honest).to.not.equal(ethers.ZeroHash);
      expect(forged).to.equal(ethers.ZeroHash);
    });

    it("returns canonical hash when exact field directives match and zero when a field mismatches", async function () {
      const { guard, manager, user } = await deployGuardFixture();
      const toWord = addressWord(user.address);
      const amountWord = uintWord(42n);
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
          buildTypedExactSignDirective(REQUEST_TYPEHASH, [toWord, amountWord]),
        ]);

      const result = await guard.eip712Hash(
        DAPP_ID,
        buildOps([toWord, amountWord], DOMAIN_SEPARATOR, REQUEST_TYPEHASH),
      );
      const structHash = ethers.keccak256(ethers.concat([REQUEST_TYPEHASH, toWord, amountWord]));
      expect(result).to.equal(ethers.keccak256(ethers.concat(["0x1901", DOMAIN_SEPARATOR, structHash])));

      const mismatch = await guard.eip712Hash(
        DAPP_ID,
        buildOps([toWord, uintWord(43n)], DOMAIN_SEPARATOR, REQUEST_TYPEHASH),
      );
      expect(mismatch).to.equal(ethers.ZeroHash);
    });

    it("handles nested structs with exact and self directives", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const toWord = addressWord(user.address);
      const refWord = addressWord(other.address);
      const amountWord = uintWord(77n);
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
          buildExactSignDirective([OUTER_TYPEHASH, toWord, INNER_TYPEHASH, refWord, amountWord]),
        ]);

      const result = await guard.eip712Hash(DAPP_ID, buildNestedOps(toWord, refWord, amountWord, DOMAIN_SEPARATOR));
      const innerHash = ethers.keccak256(ethers.concat([INNER_TYPEHASH, refWord, amountWord]));
      const outerHash = ethers.keccak256(ethers.concat([OUTER_TYPEHASH, toWord, innerHash]));
      expect(result).to.equal(ethers.keccak256(ethers.concat(["0x1901", DOMAIN_SEPARATOR, outerHash])));

      const mismatch = await guard.eip712Hash(
        DAPP_ID,
        buildNestedOps(toWord, refWord, uintWord(99n), DOMAIN_SEPARATOR),
      );
      expect(mismatch).to.equal(ethers.ZeroHash);

      await guard.connect(manager).whitelistEIP712(DAPP_ID, ethers.id("SELF_DOMAIN"), [
        {
          directives: [
            (TYPE_EXACT << 5) | 0,
            (TYPE_EXACT << 5) | 1,
            (TYPE_EXACT << 5) | 2,
            TYPE_SELF << 5,
            (TYPE_EXACT << 5) | 3,
          ],
          dictionary: ethers.concat([OUTER_TYPEHASH, toWord, INNER_TYPEHASH, amountWord]),
        },
      ]);
      const selfMatch = await guard
        .connect(other)
        .eip712Hash(DAPP_ID, buildNestedOps(toWord, refWord, amountWord, ethers.id("SELF_DOMAIN")));
      expect(selfMatch).to.not.equal(ethers.ZeroHash);
      const selfMismatch = await guard
        .connect(user)
        .eip712Hash(DAPP_ID, buildNestedOps(toWord, refWord, amountWord, ethers.id("SELF_DOMAIN")));
      expect(selfMismatch).to.equal(ethers.ZeroHash);
    });

    it("handles arrays of values and arrays of structs", async function () {
      const { guard, manager, user, other } = await deployGuardFixture();
      const one = uintWord(1n);
      const two = uintWord(2n);
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [buildTypedExactSignDirective(ARRAY_TYPEHASH, [one, two])]);

      const arrayResult = await guard.eip712Hash(DAPP_ID, buildArrayOps([one, two], DOMAIN_SEPARATOR, ARRAY_TYPEHASH));
      const arrayHash = ethers.keccak256(ethers.concat([one, two]));
      const arrayStructHash = ethers.keccak256(ethers.concat([ARRAY_TYPEHASH, arrayHash]));
      expect(arrayResult).to.equal(ethers.keccak256(ethers.concat(["0x1901", DOMAIN_SEPARATOR, arrayStructHash])));

      const mismatch = await guard.eip712Hash(
        DAPP_ID,
        buildArrayOps([one, uintWord(3n)], DOMAIN_SEPARATOR, ARRAY_TYPEHASH),
      );
      expect(mismatch).to.equal(ethers.ZeroHash);

      const structDomain = ethers.id("STRUCT_ARRAY_DOMAIN");
      const itemA: [string, string] = [addressWord(user.address), uintWord(10n)];
      const itemB: [string, string] = [addressWord(other.address), uintWord(20n)];
      await guard
        .connect(manager)
        .whitelistEIP712(DAPP_ID, structDomain, [
          buildExactSignDirective([ARRAY_STRUCT_TYPEHASH, INNER_TYPEHASH, ...itemA, INNER_TYPEHASH, ...itemB]),
        ]);

      const structArrayResult = await guard.eip712Hash(DAPP_ID, buildStructArrayOps([itemA, itemB], structDomain));
      const innerHashA = ethers.keccak256(ethers.concat([INNER_TYPEHASH, ...itemA]));
      const innerHashB = ethers.keccak256(ethers.concat([INNER_TYPEHASH, ...itemB]));
      const structArrayHash = ethers.keccak256(ethers.concat([innerHashA, innerHashB]));
      const structArrayRoot = ethers.keccak256(ethers.concat([ARRAY_STRUCT_TYPEHASH, structArrayHash]));
      expect(structArrayResult).to.equal(ethers.keccak256(ethers.concat(["0x1901", structDomain, structArrayRoot])));
    });

    it("supports mixed ANY SELF and FROM_LIST field directives", async function () {
      const { guard, manager, user, other, target } = await deployGuardFixture();
      await whitelistAddressInDapp(guard.connect(manager), target.address, DAPP_ID);
      await guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [
        {
          directives: [TYPE_ANY << 5, TYPE_ANY << 5, TYPE_SELF << 5, TYPE_FROM_LIST << 5],
          dictionary: "0x",
        },
      ]);

      const randomWord = uintWord(0xdeadbeefn);
      const result = await guard
        .connect(user)
        .eip712Hash(
          DAPP_ID,
          buildOps(
            [randomWord, addressWord(user.address), addressWord(target.address)],
            DOMAIN_SEPARATOR,
            MIXED_TYPEHASH,
          ),
        );
      const structHash = ethers.keccak256(
        ethers.concat([MIXED_TYPEHASH, randomWord, addressWord(user.address), addressWord(target.address)]),
      );
      expect(result).to.equal(ethers.keccak256(ethers.concat(["0x1901", DOMAIN_SEPARATOR, structHash])));

      const wrongSelf = await guard
        .connect(other)
        .eip712Hash(
          DAPP_ID,
          buildOps(
            [randomWord, addressWord(user.address), addressWord(target.address)],
            DOMAIN_SEPARATOR,
            MIXED_TYPEHASH,
          ),
        );
      expect(wrongSelf).to.equal(ethers.ZeroHash);

      const notListed = await guard
        .connect(user)
        .eip712Hash(
          DAPP_ID,
          buildOps(
            [randomWord, addressWord(user.address), addressWord(other.address)],
            DOMAIN_SEPARATOR,
            MIXED_TYPEHASH,
          ),
        );
      expect(notListed).to.equal(ethers.ZeroHash);
    });

    it("requires adapter manager permission for EIP-712 whitelist updates and supports removals", async function () {
      const { guard, manager, outsider } = await deployGuardFixture();
      const directive = { directives: [TYPE_ANY << 5], dictionary: "0x" };

      await expect(guard.connect(outsider).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]))
        .to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardUnauthorized")
        .withArgs(outsider.address);
      await expect(guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]))
        .to.emit(guard, "ArbitraryAdapterEIP712WhitelistUpdated")
        .withArgs(DAPP_ID, DOMAIN_SEPARATOR, true);
      await expect(guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [0n]))
        .to.emit(guard, "ArbitraryAdapterEIP712WhitelistUpdated")
        .withArgs(DAPP_ID, DOMAIN_SEPARATOR, false);
      await expect(
        guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [0n]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardIndexOutOfBounds");
    });

    it("removes multiple EIP-712 directives by sequential indexes", async function () {
      const { guard, manager } = await deployGuardFixture();
      const first = { directives: [TYPE_ANY << 5], dictionary: "0x" };
      const second = { directives: [TYPE_SELF << 5], dictionary: "0x" };

      await guard.connect(manager).whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [first, second]);
      await expect(guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [1n, 0n]))
        .to.emit(guard, "ArbitraryAdapterEIP712WhitelistUpdated")
        .withArgs(DAPP_ID, DOMAIN_SEPARATOR, false);
      await expect(
        guard.connect(manager).unwhitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [0n]),
      ).to.be.revertedWithCustomError(guard, "ArbitraryAdapterGuardIndexOutOfBounds");
    });
  });
});
