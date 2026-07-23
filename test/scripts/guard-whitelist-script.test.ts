import { expect } from "chai";
import fs from "node:fs/promises";

describe("guard whitelist scripts", function () {
  it("exposes package aliases and calls guard whitelist methods", async function () {
    const packageJson = await fs.readFile("package.json", "utf8");
    const whitelistScript = await fs.readFile("scripts/exec-guard-whitelist.ts", "utf8");
    const eip712Script = await fs.readFile("scripts/exec-guard-whitelist-eip712.ts", "utf8");
    const unwhitelistScript = await fs.readFile("scripts/exec-guard-unwhitelist.ts", "utf8");
    const unwhitelistEIP712Script = await fs.readFile("scripts/exec-guard-unwhitelist-eip712.ts", "utf8");

    expect(packageJson).to.include("exec:guard:whitelist");
    expect(packageJson).to.include("exec:guard:whitelist-eip712");
    expect(packageJson).to.include("exec:guard:unwhitelist");
    expect(packageJson).to.include("exec:guard:unwhitelist-eip712");
    expect(whitelistScript).to.include('connectWithRole("PK_UFARM_OWNER")');
    expect(whitelistScript).to.include("guard.whitelistProtocol(dapp, targets, directives)");
    expect(eip712Script).to.include('connectWithRole("PK_UFARM_OWNER")');
    expect(eip712Script).to.include("guard.whitelistEIP712(dapp, domain, directives)");
    expect(unwhitelistScript).to.include('connectWithRole("PK_UFARM_OWNER")');
    expect(unwhitelistScript).to.include("guard.unwhitelistProtocol(dapp, target, indexes)");
    expect(unwhitelistEIP712Script).to.include('connectWithRole("PK_UFARM_OWNER")');
    expect(unwhitelistEIP712Script).to.include("guard.unwhitelistEIP712(dapp, domain, indexes)");
  });
});
