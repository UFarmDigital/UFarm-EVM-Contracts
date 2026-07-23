import { expect } from "chai";
import { Interface, getAddress } from "ethers";
import {
  buildQuexActionData,
  encryptQuexPatchValue,
  extractQuexBytes32EventValue,
} from "../../scripts/helpers/quex-request-helpers.js";

const TD_PUBLIC_KEY =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000002";
const REAL_TD_PUBLIC_KEY =
  "0x91b85e68863b4a58fbb9510a1dd5f0d34aa1e44de1d1eb61d9257df6276bc3da347c4b14599f2428698465a1a9fa104e959dca2183717b75e8700bc760f46f6d";

describe("Quex request helpers", function () {
  it("builds Quex request and private patch data from json input", function () {
    const actionData = buildQuexActionData(
      {
        request: {
          method: "GET",
          host: "pro-openapi.debank.com",
          path: "/v1/user/total_balance",
          headers: [{ key: "Content-Type", value: "application/json" }],
          body: "",
          parameters: [],
        },
        jqFilter: ".total_usd_value * 1000000 | floor",
        responseSchema: "uint256",
        patch: {
          pathSuffix: "",
          headers: [{ key: "AccessKey", value: "<secret-key>" }],
          parameters: [],
          body: "",
        },
      },
      TD_PUBLIC_KEY,
      (plaintext) => `0xeeee${Buffer.from(plaintext).toString("hex")}`,
    );

    expect(actionData.request).to.deep.equal({
      method: 0,
      host: "pro-openapi.debank.com",
      path: "/v1/user/total_balance",
      headers: [{ key: "Content-Type", value: "application/json" }],
      parameters: [],
      body: "0x",
    });
    expect(actionData.patch.pathSuffix).to.equal("0x");
    expect(actionData.patch.headers).to.deep.equal([
      { key: "AccessKey", ciphertext: "0xeeee3c7365637265742d6b65793e" },
    ]);
    expect(actionData.patch.parameters).to.deep.equal([]);
    expect(actionData.patch.body).to.equal("0x");
    expect(actionData.patch.tdAddress).to.equal(getAddress("0xee546e97c83a08bbccc01a0644d599ccd2a7c2e0"));
    expect(actionData.jqFilter).to.equal(".total_usd_value * 1000000 | floor");
    expect(actionData.responseSchema).to.equal("uint256");
  });

  it("extracts Quex bytes32 ids from transaction logs", function () {
    const eventInterface = new Interface(["event PrivatePatchAdded(bytes32 patchId)"]);
    const patchId = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const log = eventInterface.encodeEventLog(eventInterface.getEvent("PrivatePatchAdded")!, [patchId]);

    expect(
      extractQuexBytes32EventValue(
        eventInterface,
        [{ topics: log.topics, data: log.data }],
        "PrivatePatchAdded",
        "patchId",
      ),
    ).to.equal(patchId);
  });

  it("encrypts non-empty private patch values with a real Quex TD public key", function () {
    const encrypted = encryptQuexPatchValue("secret", REAL_TD_PUBLIC_KEY);

    expect(encrypted).to.match(/^0x[0-9a-f]+$/);
    expect((encrypted.length - 2) / 2).to.equal(64 + 16 + 16 + "secret".length);
  });
});
