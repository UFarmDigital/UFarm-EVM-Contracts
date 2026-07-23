import { expect } from "chai";
import { id } from "ethers";
import {
  parseDappId,
  parseEIP712DirectiveEntries,
  parseHexBytesList,
  parseIndexList,
  parseTargetList,
} from "../../scripts/helpers/guard-whitelist-helpers.js";

describe("guard whitelist helpers", function () {
  it("parses dapp labels and bytes32 ids", function () {
    const dappId = id("ufarm.adapter.arbitrary");

    expect(parseDappId("ufarm.adapter.arbitrary")).to.equal(dappId);
    expect(parseDappId(dappId)).to.equal(dappId);
    expect(() => parseDappId("0x1234")).to.throw("must be bytes32");
  });

  it("parses comma-separated targets and hex directive bytes", function () {
    expect(
      parseTargetList("0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002"),
    ).to.deep.equal(["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"]);
    expect(parseHexBytesList("0x1234,0xabcd")).to.deep.equal(["0x1234", "0xabcd"]);
    expect(() => parseHexBytesList("0x123")).to.throw("hex bytes");
  });

  it("parses eip712 directive entries into uint8 arrays and dictionaries", function () {
    expect(parseEIP712DirectiveEntries("0x204060,0x;0x2080,0x1234")).to.deep.equal([
      { directives: [0x20, 0x40, 0x60], dictionary: "0x" },
      { directives: [0x20, 0x80], dictionary: "0x1234" },
    ]);
  });

  it("parses comma-separated unwhitelist indexes", function () {
    expect(parseIndexList("0,2,10")).to.deep.equal([0n, 2n, 10n]);
    expect(() => parseIndexList("-1")).to.throw("invalid --idx value");
    expect(() => parseIndexList("abc")).to.throw("invalid --idx value");
  });
});
