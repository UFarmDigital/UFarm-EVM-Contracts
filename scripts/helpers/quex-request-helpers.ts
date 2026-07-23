import { randomBytes, createCipheriv } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { Interface, getAddress, hexlify, isHexString, keccak256 } from "ethers";

const HTTP_METHODS = new Map<string, number>([
  ["GET", 0],
  ["POST", 1],
  ["PUT", 2],
  ["PATCH", 3],
  ["DELETE", 4],
  ["OPTIONS", 5],
  ["TRACE", 6],
]);

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

type HeaderOrParameterInput = {
  key: string;
  value: string;
};

type QuexRequestInput = {
  request: {
    method: string | number;
    host: string;
    path: string;
    headers?: HeaderOrParameterInput[];
    parameters?: HeaderOrParameterInput[];
    body?: string;
  };
  jqFilter: string;
  responseSchema: string;
  patch?: {
    pathSuffix?: string;
    headers?: HeaderOrParameterInput[];
    parameters?: HeaderOrParameterInput[];
    body?: string;
  };
};

export type QuexRequestData = {
  method: number;
  host: string;
  path: string;
  headers: HeaderOrParameterInput[];
  parameters: HeaderOrParameterInput[];
  body: string;
};

export type QuexPrivatePatchData = {
  pathSuffix: string;
  headers: { key: string; ciphertext: string }[];
  parameters: { key: string; ciphertext: string }[];
  body: string;
  tdAddress: string;
};

export type QuexActionData = {
  request: QuexRequestData;
  patch: QuexPrivatePatchData;
  jqFilter: string;
  responseSchema: string;
};

export type PatchEncryptor = (plaintext: string) => string;

type QuexLog = {
  topics: readonly string[];
  data: string;
};

export function buildQuexActionData(
  input: QuexRequestInput,
  tdPublicKey: string,
  encryptor: PatchEncryptor = (plaintext) => encryptQuexPatchValue(plaintext, tdPublicKey),
): QuexActionData {
  const tdPublicKeyBytes = hexToBytes(tdPublicKey, "--td-pubkey");
  if (tdPublicKeyBytes.length !== 64) {
    throw new Error("--td-pubkey must be a 64-byte secp256k1 public key without the 0x04 prefix");
  }

  const patch = input.patch ?? {};
  return {
    request: {
      method: parseHttpMethod(input.request.method),
      host: requireString("request.host", input.request.host),
      path: requireString("request.path", input.request.path),
      headers: normalizePairs(input.request.headers),
      parameters: normalizePairs(input.request.parameters),
      body: encodeBody(input.request.body ?? ""),
    },
    patch: {
      pathSuffix: encryptPatchValue(patch.pathSuffix ?? "", encryptor),
      headers: encryptPairs(patch.headers, encryptor),
      parameters: encryptPairs(patch.parameters, encryptor),
      body: encryptPatchValue(patch.body ?? "", encryptor),
      tdAddress: publicKeyToAddress(tdPublicKeyBytes),
    },
    jqFilter: requireString("jqFilter", input.jqFilter),
    responseSchema: requireString("responseSchema", input.responseSchema),
  };
}

export function encryptQuexPatchValue(plaintext: string, tdPublicKey: string): string {
  if (plaintext.length === 0) return "0x";

  const tdPublicKeyBytes = hexToBytes(tdPublicKey, "--td-pubkey");
  if (tdPublicKeyBytes.length !== 64) {
    throw new Error("--td-pubkey must be a 64-byte secp256k1 public key without the 0x04 prefix");
  }

  const scalar = randomScalar();
  const recipient = secp256k1.ProjectivePoint.fromHex(bytesToHex(new Uint8Array([4, ...tdPublicKeyBytes])));
  const ephemeral = secp256k1.ProjectivePoint.BASE.multiply(scalar).toRawBytes(false).slice(1);
  const sharedPoint = recipient.multiply(scalar).toRawBytes(false).slice(1);
  const key = hkdf(
    sha256,
    concatBytes(bytesFromHex("04"), ephemeral, bytesFromHex("04"), sharedPoint),
    undefined,
    undefined,
    32,
  );
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();

  return hexlify(Buffer.concat([Buffer.from(ephemeral), nonce, tag, ciphertext]));
}

export function extractQuexBytes32EventValue(
  contractInterface: Interface,
  logs: readonly QuexLog[],
  eventName: string,
  argumentName: string,
): string {
  for (const log of logs) {
    try {
      const parsed = contractInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === eventName) {
        const value = parsed.args[argumentName];
        if (typeof value !== "string" || !isHexString(value, 32)) {
          throw new Error(`${eventName}.${argumentName} must be bytes32`);
        }
        return value;
      }
    } catch {
      continue;
    }
  }

  throw new Error(`${eventName} was not emitted`);
}

function parseHttpMethod(method: string | number): number {
  if (typeof method === "number") {
    if (!Number.isInteger(method) || method < 0 || method > 6) {
      throw new Error("request.method must be a valid Quex HTTP method");
    }
    return method;
  }

  const methodId = HTTP_METHODS.get(method.toUpperCase());
  if (methodId === undefined) {
    throw new Error(`unsupported request.method: ${method}`);
  }
  return methodId;
}

function normalizePairs(pairs: HeaderOrParameterInput[] | undefined): HeaderOrParameterInput[] {
  return (pairs ?? []).map((pair) => ({
    key: requireString("key", pair.key),
    value: requireString("value", pair.value),
  }));
}

function encryptPairs(pairs: HeaderOrParameterInput[] | undefined, encryptor: PatchEncryptor) {
  return (pairs ?? []).map((pair) => ({
    key: requireString("key", pair.key),
    ciphertext: encryptPatchValue(pair.value, encryptor),
  }));
}

function encryptPatchValue(value: string, encryptor: PatchEncryptor): string {
  const normalized = requireString("patch value", value);
  return normalized.length === 0 ? "0x" : encryptor(normalized);
}

function encodeBody(body: string): string {
  const normalized = requireString("request.body", body);
  return isHexString(normalized) ? normalized : hexlify(Buffer.from(normalized, "utf8"));
}

function requireString(name: string, value: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function publicKeyToAddress(publicKeyBytes: Uint8Array): string {
  return getAddress(`0x${keccak256(publicKeyBytes).slice(-40)}`);
}

function randomScalar(): bigint {
  while (true) {
    const random = randomBytes(32);
    const scalar = littleEndianBytesToBigInt(random);
    if (scalar > 0n && scalar < SECP256K1_ORDER) return scalar;
  }
}

function littleEndianBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; --i) {
    value = (value << 8n) + BigInt(bytes[i]);
  }
  return value;
}

function hexToBytes(hex: string, name: string): Uint8Array {
  if (!isHexString(hex)) {
    throw new Error(`${name} must be hex bytes`);
  }
  return bytesFromHex(hex.slice(2));
}

function bytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}
