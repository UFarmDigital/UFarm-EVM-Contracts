import { expect } from "chai";
import { id } from "ethers";
import { buildCreateXSalt } from "../../scripts/helpers/deploy-helpers.js";

describe("CreateX deploy script salt helper", function () {
  it("formats a sender-bound CreateX salt with an explicit no-chain-protection flag", function () {
    const deployer = "0x000000000000000000000000000000000000CAFE";
    const logicalSalt = id("UFARM_FOUNDATION");

    const salt = buildCreateXSalt(deployer, logicalSalt);

    expect(salt.slice(0, 42).toLowerCase()).to.equal(deployer.toLowerCase());
    expect(salt.slice(42, 44)).to.equal("00");
    expect(salt.slice(44)).to.equal(logicalSalt.slice(44));
    expect((salt.length - 2) / 2).to.equal(32);
  });
});
