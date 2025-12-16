// SPDX-License-Identifier: UNLICENSED

import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { guardWithPoolFixture } from './_fixtures'
import { Guard2 } from '../typechain-types'

describe('Guard2 test', function () {
  const DAPP_ID = ethers.utils.formatBytes32String("DAPP")

  const TYPE_WC_W = 0;
  const TYPE_ANY = 1;
  const TYPE_SELF = 2;
  const TYPE_WL = 3;
  const TYPE_EXACT = 4;
  const TYPE_WC_B = 5;

  const encodeDirective = (segments: Array<{ typ: number, span: number, data?: string }>) => {
    const bytes: number[] = [];
    for (const seg of segments) {
      const header = (seg.typ << 5) | (seg.span - 1);
      bytes.push(header);
      if (seg.typ === TYPE_EXACT && seg.data) {
        const dataBytes = Array.from(ethers.utils.arrayify(seg.data));
        bytes.push(...dataBytes);
      }
    }
    return ethers.utils.hexlify(bytes);
  };

  const encodeSelectorDirective = (selector: string): string => {
    return encodeDirective([{ typ: TYPE_EXACT, span: 4, data: selector }]);
  };

  const createCalldata = (selector: string, args: string[] = []): string => {
    return ethers.utils.hexlify(
      ethers.utils.concat([
        ethers.utils.arrayify(selector),
        ...args.map(arg => ethers.utils.zeroPad(arg, 32))
      ])
    );
  };

  const whitelistAddressInDapp = async (addr: string, guard2: Guard2) => {
    const dummyDir = encodeDirective([{ typ: TYPE_EXACT, span: 4, data: "0x11111111" }]);
    await guard2.whitelistProtocol(DAPP_ID, [addr], [dummyDir]);
  }

  describe("Guard2 - Core Whitelist Logic Only", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance.connect(owner);
    });

    it("allows exact selector match", async function () {
      const selector = ethers.utils.id("foo()").slice(0, 10);
      const directive = encodeSelectorDirective(selector);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);
      const call = createCalldata(selector);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, call)).to.be.true;
    });

    it("allows fixed wildcard (typ=0) skipping argument", async () => {
      const selector = ethers.utils.id("foo(uint256)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 }
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);
      const call = createCalldata(selector, ["0x1234"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, call)).to.be.true;
    });

    it("allows any-length wildcard (typ=1) if last", async () => {
      const selector = ethers.utils.id("log(bytes)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_ANY, span: 1 }
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const payload1 = createCalldata(selector, ["0x1234"]);
      const payload2 = createCalldata(selector, ["0x1234", "0x5678"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload1)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload2)).to.be.true;
    });

    it("allows match if argument equals msg.sender (typ=2)", async () => {
      const selector = ethers.utils.id("setOwner(address)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_SELF, span: 32 }
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [otherAddr], [directive]);

      const payload = createCalldata(selector, [userAddr]);
      expect(await guard2.connect(await ethers.getSigner(userAddr)).callStatic.isProtocolAllowed(DAPP_ID, otherAddr, payload)).to.be.true;
    });

    it("allows match if argument is whitelisted address (typ=3)", async () => {
      const selector = ethers.utils.id("depositTo(address)").slice(0, 10);
      const dummySel = encodeSelectorDirective("0x11111111");
      await guard2.whitelistProtocol(DAPP_ID, [otherAddr], [dummySel]);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WL, span: 32 }
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const payload = createCalldata(selector, [otherAddr]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
    });
  });

  describe("Guard2 - TYPE_WILDCARD_WORDS", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ Skip 1 word: ensure any 32-byte value at that offset is accepted
    it("TYPE_WILDCARD_WORDS: skip 1 word accepts any 32-byte value", async () => {
      const selector = ethers.utils.id("foo(uint256)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 }, // skip 1 × 32B word
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // any 32B value in that slot should pass
      const callA = createCalldata(selector, ["0x01"]);
      const callB = createCalldata(selector, ["0x1234"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, callA)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, callB)).to.be.true;
    });

    // ✅ Skip 2+ words: test larger payloads where multiple arguments are skipped
    it("TYPE_WILDCARD_WORDS: skip 2 words accepts any two 32-byte args", async () => {
      const selector = ethers.utils.id("bar(uint256,uint256)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 2 }, // skip 2 × 32B words
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const call = createCalldata(selector, ["0xdeadbeef", "0xcafe"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, call)).to.be.true;
    });

    // ❌ Skip 1 word, but payload too short → should return false
    it("TYPE_WILDCARD_WORDS: skip 1 word but payload too short", async () => {
      const selector = ethers.utils.id("short(uint256)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 },
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const tooShort = selector; // only 4-byte selector, missing the 32B arg
      const allowed = await guard2.isProtocolAllowed(DAPP_ID, userAddr, tooShort);
      expect(allowed).to.be.false;
    });

    // 🔁 Combine with TYPE_EXACT following it to test skipping + matching
    it("TYPE_WILDCARD_WORDS + TYPE_EXACT: skip first arg, enforce second exact 32B", async () => {
      const selector = ethers.utils.id("pair(uint256,uint256)").slice(0, 10);
      const exactValue = ethers.utils.hexZeroPad("0x2a", 32); // 42 padded to 32B

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 },                       // skip first 32B arg
        { typ: TYPE_EXACT, span: 32, data: exactValue },   // second arg must be 42
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const ok = createCalldata(selector, ["0x1234", "0x2a"]);
      const bad = createCalldata(selector, ["0x1234", "0x2b"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.be.false;
    });

    // 🧪 Mix with TYPE_SELF later in the directive (skip first arg, second must equal msg.sender)
    it("TYPE_WILDCARD_WORDS + TYPE_SELF: skip first arg, then require msg.sender", async () => {
      const selector = ethers.utils.id("op(uint256,address)").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 },    // skip 1st arg (uint256)
        { typ: TYPE_SELF, span: 32 },   // 2nd arg (address padded) must equal msg.sender
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const ok = createCalldata(selector, ["0x1234", userAddr]);
      const bad = createCalldata(selector, ["0x1234", otherAddr]);

      // msg.sender = userAddr
      expect(
        await guard2.connect(await ethers.getSigner(userAddr))
          .callStatic.isProtocolAllowed(DAPP_ID, userAddr, ok)
      ).to.be.true;

      expect(
        await guard2.connect(await ethers.getSigner(userAddr))
          .callStatic.isProtocolAllowed(DAPP_ID, userAddr, bad)
      ).to.be.false;
    });

    // 🧪 Mix with TYPE_WL later in the directive (skip first arg, second must be whitelisted)
    it("TYPE_WILDCARD_WORDS + TYPE_WL: skip first arg, then require whitelisted address", async () => {
      const selector = ethers.utils.id("route(uint256,address)").slice(0, 10);

      // First ensure otherAddr is whitelisted in this dapp
      const dummyDirective = encodeDirective([{ typ: TYPE_EXACT, span: 4, data: "0x11111111" }]);
      await guard2.whitelistProtocol(DAPP_ID, [otherAddr], [dummyDirective]);

      // Now add directive on userAddr: skip arg1, arg2 must be an address present in whitelist[dapp][arg2]
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W, span: 1 },   // skip 1st arg
        { typ: TYPE_WL, span: 32 },    // 2nd arg must be whitelisted address (padded)
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const ok = createCalldata(selector, ["0x1234", otherAddr]);
      const bad = createCalldata(selector, ["0x1234", ownerAddr]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.be.false;
    });
  });

  describe("Guard2 - TYPE_ANY", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ Appears last → should allow any trailing payload (including 0 bytes)
    it("TYPE_ANY: appears last — allows any trailing payload (including 0 bytes)", async () => {
      const selector = ethers.utils.id("anyTail()").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_ANY,   span: 1 }, // last — matches rest
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // 0 bytes trailing
      const p0 = createCalldata(selector, []);
      // 1 word trailing
      const p1 = createCalldata(selector, ["0x01"]);
      // 2 words trailing
      const p2 = createCalldata(selector, ["0xdead", "0xbeef"]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, p0)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, p1)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, p2)).to.equal(true);
    });

    // ❌ Appears not last → should revert on whitelist setup (InvalidInput)
    it("TYPE_ANY: not last — whitelistProtocol reverts with InvalidInput", async () => {
      const selector = ethers.utils.id("badLayout()").slice(0, 10);

      // ANY then another segment => invalid
      const badDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_ANY,   span: 1 },                // not last
        { typ: TYPE_EXACT, span: 1, data: "0x12" },  // anything after ANY makes it invalid
      ]);

      await expect(
        guard2.whitelistProtocol(DAPP_ID, [userAddr], [badDirective])
      ).to.be.revertedWithCustomError(guard2, "InvalidInput");
    });

    // ✅ Appears after selector + fixed fields → trailing variable payload accepted
    it("TYPE_ANY: after selector + fixed exact prefix — trailing variable payload accepted", async () => {
      const selector = ethers.utils.id("prefixed(bytes)").slice(0, 10);
      const exact32 = ethers.utils.hexZeroPad("0x2a", 32); // 42 padded

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector }, // selector
        { typ: TYPE_EXACT, span: 32, data: exact32  }, // required constant prefix
        { typ: TYPE_ANY,   span: 1 },                  // rest arbitrary
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const ok_min = ethers.utils.hexConcat([selector, exact32]); // no trailing bytes
      const ok_more = ethers.utils.hexConcat([
        selector,
        exact32,
        ethers.utils.hexlify(ethers.utils.randomBytes(64)),
      ]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok_min)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok_more)).to.equal(true);

      // Wrong prefix constant => must be false (no revert in isProtocolAllowed)
      const wrong32 = ethers.utils.hexZeroPad("0x2b", 32);
      const bad = ethers.utils.hexConcat([selector, wrong32, "0x1234"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.equal(false);
    });

    // 🧪 Combine with TYPE_EXACT before it to test structured + trailing arbitrary data
    it("TYPE_ANY: structured prefix (multiple EXACT) + ANY for tail", async () => {
      const selector = ethers.utils.id("structuredTail()").slice(0, 10);
      const constA = "0x11223344";
      const constB = "0xaabbccdd";

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },      // selector
        { typ: TYPE_EXACT, span: 4, data: constA },        // small exact chunk (4B)
        { typ: TYPE_EXACT, span: 4, data: constB },        // another 4B exact
        { typ: TYPE_ANY,   span: 1 },                      // anything after
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const base = ethers.utils.hexConcat([selector, constA, constB]);
      const ok0 = base; // no trailing bytes
      const ok1 = ethers.utils.hexConcat([base, "0xdeadbeef"]);
      const ok2 = ethers.utils.hexConcat([base, ethers.utils.hexlify(ethers.utils.randomBytes(100))]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok0)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok1)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok2)).to.equal(true);

      const bad = ethers.utils.hexConcat([selector, constA, "0x00000000"]); // breaks the second EXACT
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.equal(false);
    });

    // ✅ Use with long payloads (simulate calldata with trailing encoded arrays)
    it("TYPE_ANY: accepts very long tails (simulated bytes/array payloads)", async () => {
      const selector = ethers.utils.id("longTail(bytes)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_ANY,   span: 1 }, // match the rest unbounded
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // Construct a very long payload: selector + 4 KB random data
      const longData = ethers.utils.hexlify(ethers.utils.randomBytes(4096));
      const longPayload = ethers.utils.hexConcat([selector, longData]);

      // Also test "ABI-like" shape: selector + (length word) + data
      const lengthWord = ethers.utils.hexZeroPad("0x400", 32); // pretend length = 1024 bytes
      const mockBytes = ethers.utils.hexlify(ethers.utils.randomBytes(1024));
      const abiLike = ethers.utils.hexConcat([selector, lengthWord, mockBytes]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, longPayload)).to.equal(true);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, abiLike)).to.equal(true);
    });
  });

  describe("Guard2 - TYPE_SELF", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ 20-byte comparison (typical address; span = 20)
    it("TYPE_SELF: 20-byte comparison against msg.sender", async () => {
      const selector = ethers.utils.id("setOwner(address)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_SELF,  span: 20 }, // 20-byte address comparison (packed)
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // Build payload: selector + raw 20-byte address (no padding)
      const raw20 = userAddr; // 20 bytes
      const payload = ethers.utils.hexConcat([selector, raw20]);

      const userSigner = await ethers.getSigner(userAddr);
      const ok = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, payload);
      expect(ok).to.be.true;
    });

    // ✅ 32-byte comparison (address padded to full word; span = 32)
    it("TYPE_SELF: 32-byte (word-padded) comparison against msg.sender", async () => {
      const selector = ethers.utils.id("authorize(address)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_SELF,  span: 32 }, // 32-byte word (ABI-style) address
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const payload = createCalldata(selector, [userAddr]); // pads to 32B
      const userSigner = await ethers.getSigner(userAddr);
      const ok = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, payload);
      expect(ok).to.be.true;
    });

    // ❌ mismatch in payload vs msg.sender → should return false
    it("TYPE_SELF: mismatch address vs msg.sender returns false (20B and 32B)", async () => {
      const selector20 = ethers.utils.id("setOwner(address)").slice(0, 10);
      const selector32 = ethers.utils.id("authorize(address)").slice(0, 10);

      // 20-byte case
      const dir20 = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector20 },
        { typ: TYPE_SELF,  span: 20 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir20]);

      const payload20 = ethers.utils.hexConcat([selector20, otherAddr]);
      const userSigner = await ethers.getSigner(userAddr);
      const res20 = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, payload20);
      expect(res20).to.be.false;

      // 32-byte case
      const dir32 = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector32 },
        { typ: TYPE_SELF,  span: 32 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir32]);

      const payload32 = createCalldata(selector32, [otherAddr]); // padded to 32B
      const res32 = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, payload32);
      expect(res32).to.be.false;
    });

    // ❌ invalid span (<20 or >32) → either reject at setup or skip matching
    it("TYPE_SELF: invalid span (<20) rejected on whitelist OR yields non-matching behavior", async () => {
      const selector = ethers.utils.id("selfBadSpan()").slice(0, 10);

      const badDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_SELF,  span: 19 }, // invalid: < 20
      ]);

      await expect(
        guard2.whitelistProtocol(DAPP_ID, [userAddr], [badDirective])
      ).to.be.revertedWithCustomError(guard2, "InvalidInput");
    });

    it("TYPE_SELF: invalid span (>32) rejected on whitelist OR yields non-matching behavior", async () => {
      const selector = ethers.utils.id("selfBadSpan2()").slice(0, 10);

      const badDirective = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_SELF,  span: 33 }, // invalid: > 32
      ]);

      await expect(
        guard2.whitelistProtocol(DAPP_ID, [userAddr], [badDirective])
      ).to.be.revertedWithCustomError(guard2, "InvalidInput");
    });

    // 🧪 Embed between TYPE_EXACT and TYPE_ANY to test position-dependent behavior
    it("TYPE_SELF: EXACT selector → SELF (20B) → ANY; correct address passes, wrong fails", async () => {
      const selector = ethers.utils.id("pipe(address,bytes)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector }, // selector
        { typ: TYPE_SELF,  span: 20 },                 // address equals msg.sender (packed)
        { typ: TYPE_ANY,   span: 1 },                  // trailing arbitrary data
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const userSigner = await ethers.getSigner(userAddr);

      // OK: selector + 20B userAddr + arbitrary tail
      const okPayload = ethers.utils.hexConcat([
        selector,
        userAddr,
        ethers.utils.hexlify(ethers.utils.randomBytes(64)),
      ]);
      const ok = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, okPayload);
      expect(ok).to.be.true;

      // BAD: same but with otherAddr in the SELF position
      const badPayload = ethers.utils.hexConcat([
        selector,
        otherAddr,
        ethers.utils.hexlify(ethers.utils.randomBytes(16)),
      ]);
      const bad = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, badPayload);
      expect(bad).to.be.false;
    });

    it("TYPE_SELF: EXACT selector → SELF (32B) → ANY; supports ABI-style padded address", async () => {
      const selector = ethers.utils.id("pipePadded(address,bytes)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_SELF,  span: 32 }, // ABI-style 32B padded address
        { typ: TYPE_ANY,   span: 1 },  // arbitrary tail
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const userSigner = await ethers.getSigner(userAddr);
      const okPayload = createCalldata(selector, [userAddr]); // pads to 32B, no extra tail
      const ok = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, okPayload);
      expect(ok).to.be.true;

      const badPayload = createCalldata(selector, [otherAddr]); // wrong address
      const bad = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, badPayload);
      expect(bad).to.be.false;

      // With trailing data after the 32B address (ANY should accept)
      const tail = ethers.utils.hexlify(ethers.utils.randomBytes(96));
      const okWithTail = ethers.utils.hexConcat([okPayload, tail]);
      const ok2 = await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, okWithTail);
      expect(ok2).to.be.true;
    });
  });

  describe("Guard2 - TYPE_FROM_LIST", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ 20-byte whitelisted address → returns true
    it("TYPE_WL: 20-byte whitelisted address matches (packed address)", async () => {
      const selector = ethers.utils.id("route(address)").slice(0, 10);

      // ensure otherAddr is whitelisted in this dapp
      await whitelistAddressInDapp(otherAddr, guard2);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_WL,    span: 20 }, // packed 20B address
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // payload: selector + raw 20-byte address (no 32B padding)
      const payload = ethers.utils.hexConcat([selector, otherAddr]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
    });

    // ✅ 32-byte whitelisted address → returns true
    it("TYPE_WL: 32-byte (word-padded) whitelisted address matches", async () => {
      const selector = ethers.utils.id("routePad(address)").slice(0, 10);

      await whitelistAddressInDapp(otherAddr, guard2);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_WL,    span: 32 }, // ABI-style 32B padded address
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const payload = createCalldata(selector, [otherAddr]); // pads address to 32B
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
    });

    // ❌ address is not whitelisted → returns false
    it("TYPE_WL: non-whitelisted address returns false (20B and 32B)", async () => {
      const sel20 = ethers.utils.id("x(address)").slice(0, 10);
      const dir20 = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: sel20 },
        { typ: TYPE_WL,    span: 20 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir20]);

      const payload20 = ethers.utils.hexConcat([sel20, otherAddr]); // otherAddr is NOT whitelisted as target
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload20)).to.be.false;

      const sel32 = ethers.utils.id("y(address)").slice(0, 10);
      const dir32 = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: sel32 },
        { typ: TYPE_WL,    span: 32 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir32]);

      const payload32 = createCalldata(sel32, [otherAddr]); // still not whitelisted
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload32)).to.be.false;
    });

    // 🧪 address was whitelisted but then unwhitelisted → returns false
    it("TYPE_WL: becomes false after the referenced address is unwhitelisted", async () => {
      const selector = ethers.utils.id("useWL(address)").slice(0, 10);

      // whitelist otherAddr first so it qualifies
      const dummyDir = encodeDirective([{ typ: TYPE_EXACT, span: 4, data: "0x11111111" }]);
      await guard2.whitelistProtocol(DAPP_ID, [otherAddr], [dummyDir]); // index 0 for otherAddr

      const mainDir = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_WL,    span: 32 }, // padded address
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [mainDir]);

      const okPayload = createCalldata(selector, [otherAddr]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, okPayload)).to.be.true;

      // now unwhitelist the only entry for otherAddr in this dapp (index 0)
      await guard2.unwhitelistProtocol(DAPP_ID, otherAddr, 0);

      // should no longer pass
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, okPayload)).to.be.false;
    });

    // 🧪 same address whitelisted in another dapp → must still return false
    it("TYPE_WL: whitelisted in another dapp does NOT count in current dapp", async () => {
      const OTHER_DAPP = ethers.utils.formatBytes32String("OTHER_DAPP");
      const selector = ethers.utils.id("cross(address)").slice(0, 10);

      // Whitelist otherAddr in OTHER_DAPP (not in DAPP_ID)
      const dummyDir = encodeDirective([{ typ: TYPE_EXACT, span: 4, data: "0x11111111" }]);
      await guard2.whitelistProtocol(OTHER_DAPP, [otherAddr], [dummyDir]);

      // In DAPP_ID, add a directive that requires WL address
      const mainDir = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_WL,    span: 32 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [mainDir]);

      const payload = createCalldata(selector, [otherAddr]); // address is WL only in OTHER_DAPP
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.false;
    });
  });

  describe("Guard2 - TYPE_EXACT", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ Match 4-byte selector (common use)
    it("TYPE_EXACT: matches 4-byte selector", async () => {
      const selector = ethers.utils.id("onlySelector()").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector }, // require exact selector
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const payload = createCalldata(selector, []); // just selector
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
    });

    // ✅ Match 32-byte constant argument (e.g., uint256 with known value)
    it("TYPE_EXACT: matches 32-byte constant argument after selector", async () => {
      const selector = ethers.utils.id("withConst(uint256)").slice(0, 10);
      const val42_32 = ethers.utils.hexZeroPad("0x2a", 32); // 42 in 32 bytes

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector }, // selector
        { typ: TYPE_EXACT, span: 32, data: val42_32 }, // arg must be 42
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const ok = createCalldata(selector, ["0x2a"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok)).to.be.true;
    });

    // ❌ one byte mismatch → should return false
    it("TYPE_EXACT: one byte mismatch returns false", async () => {
      const selector = ethers.utils.id("withConst(uint256)").slice(0, 10);
      const val42_32 = ethers.utils.hexZeroPad("0x2a", 32);
      const val43_32 = ethers.utils.hexZeroPad("0x2b", 32);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_EXACT, span: 32, data: val42_32 },
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const bad = createCalldata(selector, ["0x2b"]); // 43 instead of 42
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.be.false;
    });

    // ❌ payload too short → should return false (adjust if your impl reverts in whitelist-time validation)
    it("TYPE_EXACT: payload too short returns false", async () => {
      const selector = ethers.utils.id("needsTwoBytes()").slice(0, 10);
      const twoBytes = "0xbeef"; // 2 bytes expected after selector

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_EXACT, span: 2, data: twoBytes }, // require 0xbeef immediately after selector
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // Build payload with only 1 byte after selector (too short)
      const short = ethers.utils.hexConcat([selector, "0xbe"]);
      // Per your note, isProtocolAllowed should not revert — just return false
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, short)).to.be.false;

      // Control: exact length and value → true
      const ok = ethers.utils.hexConcat([selector, twoBytes]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok)).to.be.true;
    });

    // 🔁 Combine multiple exact segments in sequence
    it("TYPE_EXACT: multiple exact segments in sequence must all match", async () => {
      const selector = ethers.utils.id("multiExact()").slice(0, 10);
      const A = "0x11223344"; // 4 bytes
      const B = "0xaabbccdd"; // 4 bytes
      const C = ethers.utils.hexZeroPad("0x2a", 32); // 32 bytes

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector }, // selector
        { typ: TYPE_EXACT, span: 4, data: A },        // 4B exact
        { typ: TYPE_EXACT, span: 4, data: B },        // 4B exact
        { typ: TYPE_EXACT, span: 32, data: C },       // 32B exact
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const base = ethers.utils.hexConcat([selector, A, B, C]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, base)).to.be.true;

      // Flip one byte in B → false
      const B_bad = "0xaabbccde";
      const bad1 = ethers.utils.hexConcat([selector, A, B_bad, C]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad1)).to.be.false;

      // Remove last 32B block → too short → false
      const bad2 = ethers.utils.hexConcat([selector, A, B]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad2)).to.be.false;
    });
  });

  describe("Guard2 - TYPE_WILDCARD_BYTES", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ Skip 1 byte
    it("TYPE_WILDCARD_BYTES: skip 1 byte", async () => {
      const selector = ethers.utils.id("oneByte(bytes1)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT,            span: 4, data: selector },
        { typ: TYPE_WC_B,             span: 1 }, // skip 1 byte
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // Build payload: selector + 1 arbitrary byte
      const oneByte = ethers.utils.hexlify(ethers.utils.randomBytes(1));
      const payload = ethers.utils.hexConcat([selector, oneByte]);

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
    });

    // ✅ Skip arbitrary number of bytes (e.g., 5, 13, 31)
    it("TYPE_WILDCARD_BYTES: skip arbitrary byte counts (5, 13, 31)", async () => {
      const selector = ethers.utils.id("skipN(bytes)").slice(0, 10);

      // helper to run a single case
      const run = async (n: number) => {
        const dir = encodeDirective([
          { typ: TYPE_EXACT,          span: 4, data: selector },
          { typ: TYPE_WC_B,           span: n },
        ]);
        await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir]);

        const nBytes = ethers.utils.hexlify(ethers.utils.randomBytes(n));
        const payload = ethers.utils.hexConcat([selector, nBytes]);
        expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;
      };

      await run(5);
      await run(13);
      await run(31);
    });

    // ❌ Skip more bytes than remain in payload → should return false
    it("TYPE_WILDCARD_BYTES: returns false when skipping more bytes than payload has", async () => {
      const selector = ethers.utils.id("short(bytes)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT,          span: 4, data: selector },
        { typ: TYPE_WC_B,           span: 5 }, // will require 5 bytes present
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // Provide only 3 bytes after selector (too short to satisfy skip 5)
      const tooFew = ethers.utils.hexConcat([selector, ethers.utils.hexlify(ethers.utils.randomBytes(3))]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, tooFew)).to.be.false; // no revert per your spec
    });

    // 🔁 Combine with TYPE_EXACT afterward to match specific trailing structure
    it("TYPE_WILDCARD_BYTES + TYPE_EXACT: skip N bytes then enforce trailing constant", async () => {
      const selector = ethers.utils.id("skipThenExact(bytes)").slice(0, 10);
      const n = 5;
      const tail = "0xdeadbeef"; // 4 bytes exact

      const directive = encodeDirective([
        { typ: TYPE_EXACT,          span: 4,  data: selector },
        { typ: TYPE_WC_B,           span: n },            // skip n bytes
        { typ: TYPE_EXACT,          span: 4,  data: tail } // then exact 4 bytes
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const skipped = ethers.utils.hexlify(ethers.utils.randomBytes(n));
      const okPayload  = ethers.utils.hexConcat([selector, skipped, tail]);
      const badPayload = ethers.utils.hexConcat([selector, skipped, "0xdeadbeee"]); // 1 byte mismatch

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, okPayload)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, badPayload)).to.be.false;
    });

    // 🧪 Compare with TYPE_WILDCARD_WORDS to ensure behavior differs on byte alignment
    it("TYPE_WILDCARD_BYTES vs TYPE_WILDCARD_WORDS: byte alignment differences", async () => {
      const selector = ethers.utils.id("align(bytes)").slice(0, 10);

      // Case A: bytes-skip 31 + exact 1 byte (total after selector = 31 + 1 = 32)
      const lastByte = "0xaa";
      const bytesDir = encodeDirective([
        { typ: TYPE_EXACT,            span: 4,  data: selector },
        { typ: TYPE_WC_B,             span: 31 },         // skip 31 bytes
        { typ: TYPE_EXACT,            span: 1,  data: lastByte }, // then exact 1 byte
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [bytesDir]);

      // Build payload: selector + 31 arbitrary bytes + 1 exact byte
      const thirtyOne = ethers.utils.hexlify(ethers.utils.randomBytes(31));
      const payload = ethers.utils.hexConcat([selector, thirtyOne, lastByte]);

      // This must be allowed by bytes-based wildcard
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.true;

      // Case B: words-skip 1 word + exact 1 byte -> expects 32 + 1 bytes after selector (total 33)
      const wordsDir = encodeDirective([
        { typ: TYPE_EXACT,            span: 4,  data: selector },
        { typ: TYPE_WC_W,             span: 1 },          // skip 32 bytes
        { typ: TYPE_EXACT,            span: 1,  data: lastByte }, // then exact 1 byte
      ]);
      await guard2.whitelistProtocol(DAPP_ID, [otherAddr], [wordsDir]);

      // The same 32-byte tail (31 + 1) is NOT enough for the words-based rule (needs 33)
      expect(await guard2.isProtocolAllowed(DAPP_ID, otherAddr, payload)).to.be.false;
    });
  });

  describe("Guard2 - Combining Types", function () {
    let guard2: Guard2
    let ownerAddr: string, userAddr: string, otherAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance;
    });

    // ✅ Directive: EXACT selector → WILDCARD_WORDS (2) → EXACT constant
    it("Integration: EXACT → WILDCARD_WORDS(2) → EXACT constant", async () => {
      const selector = ethers.utils.id("mixA(uint256,uint256)").slice(0, 10);
      const tail4 = "0xdeadbeef"; // 4B exact trailing constant

      const directive = encodeDirective([
        { typ: TYPE_EXACT,  span: 4,  data: selector }, // selector
        { typ: TYPE_WC_W,   span: 2 },                  // skip 2 × 32B words
        { typ: TYPE_EXACT,  span: 4,  data: tail4 },    // exact 4B tail
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      // payload: selector + 2 words (any) + tail4
      const w1 = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const w2 = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const ok = ethers.utils.hexConcat([selector, w1, w2, tail4]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, ok)).to.be.true;

      // wrong tail -> false
      const bad = ethers.utils.hexConcat([selector, w1, w2, "0xdeadbeee"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bad)).to.be.false;

      // too short (missing tail) -> false
      const short = ethers.utils.hexConcat([selector, w1, w2]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, short)).to.be.false;
    });

    // ✅ Directive: EXACT selector → WILDCARD_BYTES (5) → SELF
    it("Integration: EXACT → WILDCARD_BYTES(5) → SELF(32)", async () => {
      const selector = ethers.utils.id("mixB(bytes5,address)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT,          span: 4,  data: selector },
        { typ: TYPE_WC_B,           span: 5 },          // skip 5 bytes
        { typ: TYPE_SELF,           span: 32 },         // address padded to 32B equals msg.sender
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const five = ethers.utils.hexlify(ethers.utils.randomBytes(5));
      const addr32 = ethers.utils.hexlify(ethers.utils.zeroPad(userAddr, 32));

      const ok = ethers.utils.hexConcat([selector, five, addr32]);
      const userSigner = await ethers.getSigner(userAddr);
      expect(
        await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, ok)
      ).to.be.true;

      // mismatch self -> false
      const addr32Other = ethers.utils.hexlify(ethers.utils.zeroPad(otherAddr, 32));
      const bad = ethers.utils.hexConcat([selector, five, addr32Other]);
      expect(
        await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, bad)
      ).to.be.false;

      // too short for 5 bytes skip -> false
      const tooShort = ethers.utils.hexConcat([selector, "0x00", addr32]);
      expect(
        await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, tooShort)
      ).to.be.false;
    });

    // ✅ Directive: EXACT selector → SELF → ANY
    it("Integration: EXACT → SELF(20) → ANY", async () => {
      const selector = ethers.utils.id("mixC(address,bytes)").slice(0, 10);

      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_SELF,  span: 20 }, // packed 20B address equals msg.sender
        { typ: TYPE_ANY,   span: 1 },  // rest arbitrary
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive]);

      const userSigner = await ethers.getSigner(userAddr);

      const okPayload = ethers.utils.hexConcat([
        selector,
        userAddr, // 20B packed
        ethers.utils.hexlify(ethers.utils.randomBytes(64)),
      ]);
      expect(
        await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, okPayload)
      ).to.be.true;

      const badPayload = ethers.utils.hexConcat([
        selector,
        otherAddr, // wrong address in SELF position
        "0x",
      ]);
      expect(
        await guard2.connect(userSigner).callStatic.isProtocolAllowed(DAPP_ID, userAddr, badPayload)
      ).to.be.false;
    });

    // ❌ Directive: EXACT selector → ANY → EXACT constant → should fail on whitelist setup
    it("Integration: EXACT → ANY → EXACT constant is invalid (ANY not last)", async () => {
      const selector = ethers.utils.id("invalidAnyThenExact()").slice(0, 10);
      const directive = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_ANY,   span: 1 },               // not last -> invalid
        { typ: TYPE_EXACT, span: 4, data: "0x01020304" },
      ]);

      await expect(
        guard2.whitelistProtocol(DAPP_ID, [userAddr], [directive])
      ).to.be.revertedWithCustomError(guard2, "InvalidInput");
    });

    // 🧪 Multiple matching directives for same method — any one matching should allow
    it("Integration: multiple directives for same selector — any matching one allows", async () => {
      const selector = ethers.utils.id("multiAllow(uint256)").slice(0, 10);

      // Rule A: require const 32B = 0x2a
      const val42 = ethers.utils.hexZeroPad("0x2a", 32);
      const dirA = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_EXACT, span: 32, data: val42    },
      ]);

      // Rule B: allow any single word (wildcard)
      const dirB = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W,  span: 1 },
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dirA, dirB]);

      const call42 = createCalldata(selector, ["0x2a"]); // matches A and B
      const call43 = createCalldata(selector, ["0x2b"]); // matches B only

      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, call42)).to.be.true;
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, call43)).to.be.true;
    });

    // 🧪 Payload that could match multiple directives — should match first valid one
    it("Integration: multiple possible matches — should match first valid directive", async () => {
      const selector = ethers.utils.id("firstWins(uint256)").slice(0, 10);

      // First: requires exact = 0x2a
      const val42 = ethers.utils.hexZeroPad("0x2a", 32);
      const first = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_EXACT, span: 32, data: val42    },
      ]);

      // Second: wildcard any word
      const second = encodeDirective([
        { typ: TYPE_EXACT, span: 4, data: selector },
        { typ: TYPE_WC_W,  span: 1 },
      ]);

      // Add in this order to ensure 'first' is checked before 'second'
      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [first, second]);

      // For 0x2a, both would match – must return true
      const bothMatch = createCalldata(selector, ["0x2a"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, bothMatch)).to.be.true;

      // For 0x2b, only the second matches – still true (finds the first *valid* one, which is #2)
      const onlySecond = createCalldata(selector, ["0x2b"]);
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, onlySecond)).to.be.true;

      // (We cannot assert short-circuiting directly, but correctness is preserved.)
    });

    // ❌ Payload fails all — should return false
    it("Integration: when no directive matches, returns false", async () => {
      const selector = ethers.utils.id("noMatch(uint256)").slice(0, 10);

      const dir = encodeDirective([
        { typ: TYPE_EXACT, span: 4,  data: selector },
        { typ: TYPE_EXACT, span: 32, data: ethers.utils.hexZeroPad("0x2a", 32) },
      ]);

      await guard2.whitelistProtocol(DAPP_ID, [userAddr], [dir]);

      const payload = createCalldata(selector, ["0x2b"]); // wrong constant
      expect(await guard2.isProtocolAllowed(DAPP_ID, userAddr, payload)).to.be.false;
    });
  });
})

describe('Guard2 eip-712 test', function () {
  const DAPP_ID = ethers.utils.formatBytes32String("DAPP");
  const TYPE_ANY = 1;
  const TYPE_SELF = 2;
  const TYPE_WL = 3;
  const TYPE_EXACT = 4;
  const OPCODE_DOMAIN = '0x00';
  const OPCODE_BEGIN = '0x01';
  const OPCODE_FIELD = '0x02';
  const OPCODE_END = '0x03';
  const OPCODE_BEGIN_ARRAY = '0x04';
  const OPCODE_END_ARRAY = '0x05';
  const REQUEST_TYPEHASH = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Request(address to,uint256 amount)")
  );
  const INNER_TYPEHASH = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Inner(address ref,uint256 amount)")
  );
  const OUTER_TYPEHASH = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Outer(address to,Inner inner)Inner(address ref,uint256 amount)")
  );
  const MIXED_TYPEHASH = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Mixed(bytes32 random,address actor,address target)")
  );
  const DOMAIN_SEPARATOR = ethers.utils.id("GUARD2_EIP712");

  const exactHeader = (idx: number) => ((TYPE_EXACT << 5) | idx);
  const addressWord = (addr: string) => ethers.utils.hexZeroPad(addr, 32);
  const uintWord = (value: ethers.BigNumberish) =>
    ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toHexString(), 32);

  const buildDirective = (words: string[]): Guard2.SignDirectiveStruct => ({
    directives: words.map((_, idx) => exactHeader(idx)),
    dictionary: ethers.utils.hexConcat(words),
  });

  const buildOps = (fields: string[], typeHash: string = REQUEST_TYPEHASH): string => {
    let sequence = ethers.utils.hexConcat([
      OPCODE_DOMAIN,
      DOMAIN_SEPARATOR,
      OPCODE_BEGIN,
      typeHash,
    ]);
    for (const field of fields) {
      sequence = ethers.utils.hexConcat([sequence, OPCODE_FIELD, field]);
    }
    return ethers.utils.hexConcat([sequence, OPCODE_END]);
  };

  const buildNestedOps = (toField: string, refField: string, amountField: string): string => {
    return ethers.utils.hexConcat([
      OPCODE_DOMAIN,
      DOMAIN_SEPARATOR,
      OPCODE_BEGIN,
      OUTER_TYPEHASH,
      OPCODE_FIELD,
      toField,
      OPCODE_BEGIN,
      INNER_TYPEHASH,
      OPCODE_FIELD,
      refField,
      OPCODE_FIELD,
      amountField,
      OPCODE_END,
      OPCODE_END,
    ]);
  };

  const buildArrayOps = (elements: string[], typeHash: string): string => {
    let sequence = ethers.utils.hexConcat([
      OPCODE_DOMAIN,
      DOMAIN_SEPARATOR,
      OPCODE_BEGIN,
      typeHash,
      OPCODE_BEGIN_ARRAY,
    ]);
    for (const el of elements) {
      sequence = ethers.utils.hexConcat([sequence, OPCODE_FIELD, el]);
    }
    return ethers.utils.hexConcat([sequence, OPCODE_END_ARRAY, OPCODE_END]);
  };

  const buildStructArrayOps = (
    items: Array<[string, string]>,
    outerTypeHash: string,
    innerTypeHash: string
  ): string => {
    let sequence = ethers.utils.hexConcat([
      OPCODE_DOMAIN,
      DOMAIN_SEPARATOR,
      OPCODE_BEGIN,
      outerTypeHash,
      OPCODE_BEGIN_ARRAY,
    ]);

    for (const [refWord, amountWord] of items) {
      sequence = ethers.utils.hexConcat([
        sequence,
        OPCODE_BEGIN,
        innerTypeHash,
        OPCODE_FIELD,
        refWord,
        OPCODE_FIELD,
        amountWord,
        OPCODE_END,
      ]);
    }

    return ethers.utils.hexConcat([sequence, OPCODE_END_ARRAY, OPCODE_END]);
  };

  const whitelistAddressForEIP712 = async (addr: string, guard: Guard2) => {
    const selectorHeader = (TYPE_EXACT << 5) | (4 - 1);
    const directive = ethers.utils.hexConcat([
      ethers.utils.hexlify([selectorHeader]),
      "0x11111111",
    ]);
    await guard.whitelistProtocol(DAPP_ID, [addr], [directive]);
  };

  describe('hash calculation', function () {
    let guard2: Guard2
    let ownerAddr: string
    let userAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      guard2 = Guard2_instance.connect(owner);
    });

    it("returns canonical EIP-712 hash when payload matches directives", async () => {
      const toWord = addressWord(userAddr);
      const amountWord = uintWord(42);

      const directive = buildDirective([toWord, amountWord]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildOps([toWord, amountWord]);
      const contractHash = await guard2.eip712Hash(DAPP_ID, ops);

      const structHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([REQUEST_TYPEHASH, toWord, amountWord])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, structHash])
      );

      expect(contractHash).to.equal(expected);
    });

    it("returns zero hash when any field mismatches whitelist directive", async () => {
      const toWord = addressWord(userAddr);
      const amountWord = uintWord(42);
      const directive = buildDirective([toWord, amountWord]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildOps([toWord, uintWord(43)]);
      const hash = await guard2.eip712Hash(DAPP_ID, ops);
      expect(hash).to.equal(ethers.constants.HashZero);
    });
  });

  describe('nested fields', function () {
    let guard2: Guard2
    let ownerAddr: string
    let userAddr: string
    let otherAddr: string
    const selfDirective = (toWord: string, amountWord: string): Guard2.SignDirectiveStruct => ({
      directives: [
        (TYPE_EXACT << 5) | 0,
        (TYPE_SELF << 5),
        (TYPE_EXACT << 5) | 1,
      ],
      dictionary: ethers.utils.hexConcat([toWord, amountWord]),
    });

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance.connect(owner);
    });

    it("returns canonical hash for nested struct payloads", async () => {
      const toWord = addressWord(userAddr);
      const refWord = addressWord(otherAddr);
      const amountValue = ethers.BigNumber.from(77);
      const amountWord = uintWord(amountValue);

      const directive = buildDirective([toWord, refWord, amountWord]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildNestedOps(toWord, refWord, amountWord);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      const innerHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([INNER_TYPEHASH, refWord, amountWord])
      );
      const outerHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([OUTER_TYPEHASH, toWord, innerHash])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, outerHash])
      );

      const encoder = ethers.utils._TypedDataEncoder.from({
        Inner: [
          { name: "ref", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        Outer: [
          { name: "to", type: "address" },
          { name: "inner", type: "Inner" },
        ],
      });
      const typedStructHash = encoder.hashStruct("Outer", {
        to: userAddr,
        inner: { ref: otherAddr, amount: amountValue },
      });
      const typedDigest = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, typedStructHash])
      );

      expect(typedStructHash).to.equal(outerHash);
      expect(typedDigest).to.equal(expected);
      expect(result).to.equal(typedDigest);
    });

    it("returns zero hash when nested field mismatches whitelist", async () => {
      const toWord = addressWord(userAddr);
      const refWord = addressWord(otherAddr);
      const allowedAmount = uintWord(77);

      const directive = buildDirective([toWord, refWord, allowedAmount]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const badOps = buildNestedOps(toWord, refWord, uintWord(99));
      const result = await guard2.eip712Hash(DAPP_ID, badOps);

      expect(result).to.equal(ethers.constants.HashZero);
    });

    it("TYPE_SELF nested field matches caller", async () => {
      const toWord = addressWord(userAddr);
      const amountValue = ethers.BigNumber.from(13);
      const amountWord = uintWord(amountValue);
      const directive = selfDirective(toWord, amountWord);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const refWord = addressWord(ownerAddr);
      const ops = buildNestedOps(toWord, refWord, amountWord);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      const innerHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([INNER_TYPEHASH, refWord, amountWord])
      );
      const outerHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([OUTER_TYPEHASH, toWord, innerHash])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, outerHash])
      );

      expect(result).to.equal(expected);
    });

    it("TYPE_SELF nested field mismatch returns zero hash", async () => {
      const toWord = addressWord(userAddr);
      const amountWord = uintWord(55);
      const directive = selfDirective(toWord, amountWord);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const refWord = addressWord(otherAddr);
      const ops = buildNestedOps(toWord, refWord, amountWord);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      expect(result).to.equal(ethers.constants.HashZero);
    });

    it("TYPE_ANY inside nested field accepts arbitrary value", async () => {
      const toWord = addressWord(userAddr);
      const directive: Guard2.SignDirectiveStruct = {
        directives: [
          (TYPE_EXACT << 5) | 0,
          (TYPE_ANY << 5),
          (TYPE_ANY << 5),
        ],
        dictionary: ethers.utils.hexConcat([toWord]),
      };
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const refWord = addressWord(ownerAddr);
      const amountA = uintWord(11);
      const amountB = uintWord(22);

      const opsA = buildNestedOps(toWord, refWord, amountA);
      const opsB = buildNestedOps(toWord, refWord, amountB);

      const hashA = await guard2.eip712Hash(DAPP_ID, opsA);
      const hashB = await guard2.eip712Hash(DAPP_ID, opsB);

      expect(hashA).to.not.equal(ethers.constants.HashZero);
      expect(hashB).to.not.equal(ethers.constants.HashZero);
      expect(hashA).to.not.equal(hashB);
    });
  });

  describe('array fields', function () {
    let guard2: Guard2
    let ownerAddr: string
    let userAddr: string
    let otherAddr: string

    const ARRAY_TYPEHASH = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("ArrayHolder(uint256[] nums)")
    );
    const ARRAY_STRUCT_TYPEHASH = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("ArrayOfStructs(Inner[] items)Inner(address ref,uint256 amount)")
    );

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, other] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      otherAddr = await other.getAddress();
      guard2 = Guard2_instance.connect(owner);
    });

    it("returns canonical hash for uint256[] payloads", async () => {
      const a = uintWord(1);
      const b = uintWord(2);
      const directive = buildDirective([a, b]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildArrayOps([a, b], ARRAY_TYPEHASH);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      const arrayHash = ethers.utils.keccak256(ethers.utils.hexConcat([a, b]));
      const structHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([ARRAY_TYPEHASH, arrayHash])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, structHash])
      );

      expect(result).to.equal(expected);
    });

    it("returns zero hash when uint256[] element mismatches whitelist", async () => {
      const a = uintWord(1);
      const b = uintWord(2);
      const directive = buildDirective([a, b]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildArrayOps([a, uintWord(3)], ARRAY_TYPEHASH);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      expect(result).to.equal(ethers.constants.HashZero);
    });

    it("returns canonical hash for array of structs", async () => {
      const itemA: [string, string] = [addressWord(userAddr), uintWord(10)];
      const itemB: [string, string] = [addressWord(otherAddr), uintWord(20)];
      const directive = buildDirective([...itemA, ...itemB]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildStructArrayOps([itemA, itemB], ARRAY_STRUCT_TYPEHASH, INNER_TYPEHASH);
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      const innerHashA = ethers.utils.keccak256(
        ethers.utils.hexConcat([INNER_TYPEHASH, ...itemA])
      );
      const innerHashB = ethers.utils.keccak256(
        ethers.utils.hexConcat([INNER_TYPEHASH, ...itemB])
      );
      const arrayHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([innerHashA, innerHashB])
      );
      const structHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([ARRAY_STRUCT_TYPEHASH, arrayHash])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, structHash])
      );

      const encoder = ethers.utils._TypedDataEncoder.from({
        Inner: [
          { name: "ref", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        ArrayOfStructs: [
          { name: "items", type: "Inner[]" },
        ],
      });
      const typedHash = encoder.hashStruct("ArrayOfStructs", {
        items: [
          { ref: userAddr, amount: 10 },
          { ref: otherAddr, amount: 20 },
        ],
      });
      const typedDigest = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, typedHash])
      );

      expect(structHash).to.equal(typedHash);
      expect(expected).to.equal(typedDigest);
      expect(result).to.equal(typedDigest);
    });

    it("returns zero hash when array of structs element mismatches whitelist", async () => {
      const itemA: [string, string] = [addressWord(userAddr), uintWord(10)];
      const itemB: [string, string] = [addressWord(otherAddr), uintWord(20)];
      const directive = buildDirective([...itemA, ...itemB]);
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const ops = buildStructArrayOps(
        [itemA, [addressWord(otherAddr), uintWord(99)]],
        ARRAY_STRUCT_TYPEHASH,
        INNER_TYPEHASH
      );
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      expect(result).to.equal(ethers.constants.HashZero);
    });
  });

  describe('mixed directive types', function () {
    let guard2: Guard2
    let ownerAddr: string
    let userAddr: string
    let targetAddr: string

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture)
      const [owner, user, target] = await ethers.getSigners();
      ownerAddr = await owner.getAddress();
      userAddr = await user.getAddress();
      targetAddr = await target.getAddress();
      guard2 = Guard2_instance.connect(owner);
    });

    it("supports TYPE_ANY + TYPE_SELF + TYPE_WL matching", async () => {
      await whitelistAddressForEIP712(targetAddr, guard2);

      const directive: Guard2.SignDirectiveStruct = {
        directives: [
          (TYPE_ANY << 5),
          (TYPE_SELF << 5),
          (TYPE_WL << 5),
        ],
        dictionary: '0x',
      };
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const randomWord = ethers.utils.hexZeroPad("0xdeadbeef", 32);
      const ops = buildOps(
        [randomWord, addressWord(ownerAddr), addressWord(targetAddr)],
        MIXED_TYPEHASH
      );
      const result = await guard2.eip712Hash(DAPP_ID, ops);

      const structHash = ethers.utils.keccak256(
        ethers.utils.hexConcat([
          MIXED_TYPEHASH,
          randomWord,
          addressWord(ownerAddr),
          addressWord(targetAddr),
        ])
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.hexConcat(['0x1901', DOMAIN_SEPARATOR, structHash])
      );

      expect(result).to.equal(expected);
    });

    it("returns zero hash when TYPE_SELF field mismatches caller", async () => {
      await whitelistAddressForEIP712(targetAddr, guard2);

      const directive: Guard2.SignDirectiveStruct = {
        directives: [
          (TYPE_ANY << 5),
          (TYPE_SELF << 5),
          (TYPE_WL << 5),
        ],
        dictionary: '0x',
      };
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const randomWord = ethers.utils.hexZeroPad("0x1234", 32);
      const ops = buildOps(
        [randomWord, addressWord(userAddr), addressWord(targetAddr)],
        MIXED_TYPEHASH
      );

      const hash = await guard2.eip712Hash(DAPP_ID, ops);
      expect(hash).to.equal(ethers.constants.HashZero);
    });

    it("returns zero hash when TYPE_WL field is not whitelisted", async () => {
      const directive: Guard2.SignDirectiveStruct = {
        directives: [
          (TYPE_ANY << 5),
          (TYPE_SELF << 5),
          (TYPE_WL << 5),
        ],
        dictionary: '0x',
      };
      await guard2.whitelistEIP712(DAPP_ID, DOMAIN_SEPARATOR, [directive]);

      const randomWord = ethers.utils.hexZeroPad("0xbeef", 32);
      const ops = buildOps(
        [randomWord, addressWord(ownerAddr), addressWord(userAddr)],
        MIXED_TYPEHASH
      );

      const hash = await guard2.eip712Hash(DAPP_ID, ops);
      expect(hash).to.equal(ethers.constants.HashZero);
    });
  });

  describe("sample payload directives", function () {
    let guard2: Guard2;

    beforeEach(async () => {
      const { Guard2_instance } = await loadFixture(guardWithPoolFixture);
      const [owner] = await ethers.getSigners();
      guard2 = Guard2_instance.connect(owner);
    });

    it("whitelists sample payload directives and matches Guard2 hash", async () => {
      const sampleTypedData = {
        types: {
          Approval: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
          ],
        },
        domain: {
          name: "UFarm",
          version: "1",
          chainId: 1,
          verifyingContract: "0x1111111111111111111111111111111111111111",
        },
        message: {
          owner: "0x2222222222222222222222222222222222222222",
          spender: "0x3333333333333333333333333333333333333333",
          value: "1000000000000000000",
        },
      };
      const sampleDomain = ethers.utils._TypedDataEncoder.hashDomain(sampleTypedData.domain as any);

      await whitelistAddressForEIP712(sampleTypedData.message.owner, guard2);
      await whitelistAddressForEIP712(sampleTypedData.message.spender, guard2);

      const directive: Guard2.SignDirectiveStruct = {
        directives: [
          (TYPE_WL << 5),
          (TYPE_WL << 5),
          (TYPE_ANY << 5),
        ],
        dictionary: ethers.utils.hexConcat([uintWord(sampleTypedData.message.value)]),
      };
      await guard2.whitelistEIP712(DAPP_ID, sampleDomain, [directive]);

      const ops =
        "0x00dcd29f5a41c313e954d3bb9ff244da66aa7b0c189fd3e7840560374540a65cc2019099bf5a210fca40ad25f8da4f9b4cacc7142bac2bb1f1e40181751009d2258e020000000000000000000000002222222222222222222222222222222222222222020000000000000000000000003333333333333333333333333333333333333333020000000000000000000000000000000000000000000000000de0b6b3a764000003";

      const result = await guard2.eip712Hash(DAPP_ID, ops);
      const expected = ethers.utils._TypedDataEncoder.hash(
        sampleTypedData.domain as any,
        sampleTypedData.types,
        sampleTypedData.message
      );

      expect(result).to.equal(expected);
    });

    it("whitelists complex payload directives and matches Guard2 hash", async () => {
      const typedData = {
        types: {
          PermitBatch: [
            { name: "details", type: "PermitDetails[]" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
          PermitDetails: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
          ],
        },
        domain: {
          name: "Permit2",
          chainId: "42161",
          verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
        },
        primaryType: "PermitBatch",
        message: {
          details: [
            {
              token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
              amount: "1461501637330902918203684832716283019655932542975",
              expiration: "1767170595",
              nonce: "0",
            },
            {
              token: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
              amount: "1461501637330902918203684832716283019655932542975",
              expiration: "1767170595",
              nonce: "0",
            },
          ],
          spender: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
          sigDeadline: "1764580395",
        },
      };

      const domainHash = ethers.utils._TypedDataEncoder.hashDomain(typedData.domain as any);
      await whitelistAddressForEIP712(typedData.message.details[0].token, guard2);
      await whitelistAddressForEIP712(typedData.message.details[1].token, guard2);
      await whitelistAddressForEIP712(typedData.message.spender, guard2);
      const directive: Guard2.SignDirectiveStruct = {
        // 10 fields: [token,amount,expiration,nonce] * 2 + spender + sigDeadline
        directives: [
          (TYPE_WL << 5), // details[0].token
          (TYPE_ANY << 5), // details[0].amount
          (TYPE_ANY << 5), // details[0].expiration
          (TYPE_ANY << 5), // details[0].nonce
          (TYPE_WL << 5), // details[1].token
          (TYPE_ANY << 5), // details[1].amount
          (TYPE_ANY << 5), // details[1].expiration
          (TYPE_ANY << 5), // details[1].nonce
          (TYPE_WL << 5), // spender
          (TYPE_ANY << 5), // sigDeadline
        ],
        dictionary: '0x',
      };
      await guard2.whitelistEIP712(DAPP_ID, domainHash, [directive]);

      const ops =
        "0x008a6e6e19bdfb3db3409910416b47c2f8fc28b49488d6555c7fceaa4479135bc301af1b0d30d2cab0380e68f0689007e3254993c596f2fdd0aaa7f4d04f79440863040165626cad6cb96493bf6f5ebea28756c966f023ab9e8a83a7101849d5573b367802000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583102000000000000000000000000ffffffffffffffffffffffffffffffffffffffff02000000000000000000000000000000000000000000000000000000006954e223020000000000000000000000000000000000000000000000000000000000000000030165626cad6cb96493bf6f5ebea28756c966f023ab9e8a83a7101849d5573b367802000000000000000000000000fd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb902000000000000000000000000ffffffffffffffffffffffffffffffffffffffff02000000000000000000000000000000000000000000000000000000006954e223020000000000000000000000000000000000000000000000000000000000000000030502000000000000000000000000d88f38f930b7952f2db2432cb002e7abbf3dd8690200000000000000000000000000000000000000000000000000000000692d5c2b03";

      const result = await guard2.eip712Hash(DAPP_ID, ops);
      const expected = ethers.utils._TypedDataEncoder.hash(
        typedData.domain as any,
        typedData.types as any,
        typedData.message as any
      );

      expect(result).to.equal(expected);
    });
  });
});
