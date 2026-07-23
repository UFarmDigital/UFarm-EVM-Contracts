import { expect } from "chai";
import fs from "node:fs/promises";

describe("vault request deposit script", function () {
  it("approves the escrow for the deposit asset before requesting deposit", async function () {
    const source = await fs.readFile("scripts/exec-vault-request-deposit.ts", "utf8");

    expect(source).to.include("const escrowAddress = await vault.escrow();");
    expect(source).to.include("await token.approve(escrowAddress, assets)");
    expect(source.indexOf("await token.approve(escrowAddress, assets)")).to.be.lessThan(
      source.indexOf("requestDeposit"),
    );
  });
});
