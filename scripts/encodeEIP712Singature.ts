import { promises as fs } from "fs";
import path from "path";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

interface TypedDataField {
  name: string;
  type: string;
}

interface TypedDataPayload {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

interface FieldValue {
  path: string;
  value: string; // 0x-prefixed, 32 bytes
}

const OPCODES = {
  EIP712_DOMAIN: 0,
  EIP712_BEGIN_STRUCT: 1,
  EIP712_FIELD: 2,
  EIP712_END_STRUCT: 3,
  EIP712_BEGIN_ARRAY: 4,
  EIP712_END_ARRAY: 5
} as const;

const DIRECTIVE_TYPES = {
  ANY: 1,
  SELF: 2,
  WL: 3,
  EXACT: 4
} as const;

function usage(): never {
  console.error(
    [
      "Usage: npx ts-node scripts/composeGuard2EIP712Ops.ts <typed-data.json> [selfCSV] [wlCSV] [exactCSV] [--transact <dappId>]",
      "Provide a JSON file compatible with eth_signTypedData (types/domain/message).",
      "Optional CSV args:",
      "  self  - fields that must equal msg.sender",
      "  wl    - fields that must be whitelisted addresses",
      "  exact - fields that must match the provided value",
      "Flags:",
      "  --transact, -t  Submit whitelistEIP712 on Guard2 using env PRIVATE_KEY, RPC_URL, and optional GUARD_ADDRESS"
    ].join("\n")
  );
  process.exit(1);
}

function isArrayType(type: string): boolean {
  return /\[[0-9]*\]$/.test(type);
}

function toBytes32(hexValue: string, context: string): number[] {
  const bytes = ethers.utils.arrayify(hexValue);
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes for ${context}, got ${bytes.length}`);
  }
  return Array.from(bytes);
}

function buildStructOps(
  typeName: string,
  value: any,
  encoder: ethers.utils._TypedDataEncoder,
  structTypes: Record<string, TypedDataField[]>,
  typeHashes: Record<string, string>,
  prefix = ""
): { ops: number[]; fields: FieldValue[] } {
  const structFields = structTypes[typeName];
  if (!structFields) {
    throw new Error(`Unknown struct type: ${typeName}`);
  }
  const typeHash = typeHashes[typeName];
  if (!typeHash) {
    throw new Error(`Missing type hash for ${typeName}`);
  }

  const ops: number[] = [];
  const fields: FieldValue[] = [];
  ops.push(OPCODES.EIP712_BEGIN_STRUCT, ...toBytes32(typeHash, `${typeName} typehash`));

  for (const field of structFields) {
    if (!(field.name in value)) {
      throw new Error(`Field "${field.name}" is missing in struct ${typeName}`);
    }
    const fieldPath = prefix ? `${prefix}.${field.name}` : field.name;
    const { ops: fieldOps, fields: nestedFields } = encodeField(
      field.type,
      (value as Record<string, unknown>)[field.name],
      encoder,
      structTypes,
      typeHashes,
      fieldPath
    );
    ops.push(...fieldOps);
    fields.push(...nestedFields);
  }

  ops.push(OPCODES.EIP712_END_STRUCT);
  return { ops, fields };
}

function encodeField(
  type: string,
  value: any,
  encoder: ethers.utils._TypedDataEncoder,
  structTypes: Record<string, TypedDataField[]>,
  typeHashes: Record<string, string>,
  path: string
): { ops: number[]; fields: FieldValue[] } {
  if (structTypes[type]) {
    // Nested struct
    return buildStructOps(type, value, encoder, structTypes, typeHashes, path);
  }

  if (isArrayType(type)) {
    const match = type.match(/^(.*)\[([0-9]*)\]$/);
    const baseType = type.replace(/\[[0-9]*\]$/, "");
    const fixedLen = match && match[2] ? parseInt(match[2]) : undefined;

    if (!Array.isArray(value)) {
      throw new Error(`Expected array value for ${path}`);
    }
    if (fixedLen !== undefined && value.length !== fixedLen) {
      throw new Error(`Array length mismatch for ${path}: expected ${fixedLen}, got ${value.length}`);
    }

    const ops: number[] = [OPCODES.EIP712_BEGIN_ARRAY];
    const fields: FieldValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const { ops: nestedOps, fields: nestedFields } = encodeField(
        baseType,
        value[i],
        encoder,
        structTypes,
        typeHashes,
        `${path}[${i}]`
      );
      ops.push(...nestedOps);
      fields.push(...nestedFields);
    }
    ops.push(OPCODES.EIP712_END_ARRAY);
    return { ops, fields };
  }

  const encoderFn = encoder.getEncoder(type);
  if (!encoderFn) {
    throw new Error(`Unsupported field type: ${type}`);
  }
  const encodedValue = encoderFn(value);
  const bytes = toBytes32(encodedValue, `${type} value`);
  return {
    ops: [OPCODES.EIP712_FIELD, ...bytes],
    fields: [{ path, value: ethers.utils.hexlify(bytes) }]
  };
}

function parseCsvArg(arg: string | undefined): Set<string> {
  if (!arg) return new Set();
  return new Set(
    arg
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let transactDapp: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--transact" || arg === "-t") {
      transactDapp = argv[i + 1];
      i++;
      continue;
    }
    positional.push(arg);
  }

  const [inputPath, selfCsv = "", wlCsv = "", exactCsv = ""] = positional;
  if (!inputPath) usage();

  const selfFields = parseCsvArg(selfCsv);
  const wlFields = parseCsvArg(wlCsv);
  const exactFields = parseCsvArg(exactCsv);

  const resolvedPath = path.resolve(process.cwd(), inputPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const payload = JSON.parse(raw) as TypedDataPayload;

  if (!payload.types || !payload.primaryType || !payload.domain || !payload.message) {
    throw new Error("Typed data JSON must include types, primaryType, domain, and message");
  }
  const structTypes = Object.fromEntries(
    Object.entries(payload.types).filter(([name]) => name !== "EIP712Domain")
  ) as Record<string, TypedDataField[]>;

  if (!structTypes[payload.primaryType]) {
    throw new Error(`Primary type "${payload.primaryType}" is not defined in types`);
  }

  const encoder = ethers.utils._TypedDataEncoder.from(structTypes);
  const typeHashes: Record<string, string> = {};
  for (const name of Object.keys(structTypes)) {
    typeHashes[name] = ethers.utils.id(encoder.encodeType(name));
  }

  const domainSeparator = ethers.utils._TypedDataEncoder.hashDomain(payload.domain as any);
  const ops: number[] = [];
  const directives: number[] = [];
  const dictionary: string[] = [];

  ops.push(OPCODES.EIP712_DOMAIN, ...toBytes32(domainSeparator, "domain separator"));

  const { ops: messageOps, fields } = buildStructOps(
    payload.primaryType,
    payload.message,
    encoder,
    structTypes,
    typeHashes
  );
  ops.push(...messageOps);

  const availableFieldPaths = fields.map(f => f.path);
  console.log("Available field paths (use in self/wl/exact CSV):");
  console.log(availableFieldPaths.join("\n"));

  const seen = new Set<string>();

  for (const field of fields) {
    if (seen.has(field.path)) {
      throw new Error(`Duplicate field path encountered: ${field.path}`);
    }
    seen.add(field.path);

    const isSelf = selfFields.has(field.path);
    const isWl = wlFields.has(field.path);
    const isExact = exactFields.has(field.path);
    const tagCount = [isSelf, isWl, isExact].filter(Boolean).length;
    if (tagCount > 1) {
      throw new Error(`Field "${field.path}" specified in multiple directive lists`);
    }

    if (isExact) {
      if (dictionary.length >= 32) {
        throw new Error("Too many exact-match fields (max 32)");
      }
      const offset = dictionary.length;
      directives.push((DIRECTIVE_TYPES.EXACT << 5) | offset);
      dictionary.push(field.value);
    } else if (isSelf) {
      directives.push(DIRECTIVE_TYPES.SELF << 5);
    } else if (isWl) {
      directives.push(DIRECTIVE_TYPES.WL << 5);
    } else {
      directives.push(DIRECTIVE_TYPES.ANY << 5);
    }
  }

  const unused = [
    ...[...selfFields].filter(f => !seen.has(f)).map(f => `self:${f}`),
    ...[...wlFields].filter(f => !seen.has(f)).map(f => `wl:${f}`),
    ...[...exactFields].filter(f => !seen.has(f)).map(f => `exact:${f}`)
  ];
  if (unused.length > 0) {
    throw new Error(`Unknown field paths supplied: ${unused.join(", ")}`);
  }

  const opsHex = ethers.utils.hexlify(ops);
  const directivesHex = ethers.utils.hexlify(directives);
  const dictionaryHex = ethers.utils.hexConcat(dictionary);

  console.log("ops:", opsHex);
  console.log(
    "whitelistEIP712 args:",
    JSON.stringify(
      {
        domainSeparator,
        directive: {
          directives: directivesHex,
          dictionary: dictionaryHex
        }
      },
      null,
      2
    )
  );

  if (transactDapp) {
    const envGuard = process.env.GUARD_ADDRESS;
    const domainGuard = (payload.domain as any).verifyingContract as string | undefined;
    const guardAddress = envGuard ?? domainGuard;
    if (!guardAddress) {
      throw new Error("Guard address not provided; set GUARD_ADDRESS or domain.verifyingContract");
    }
    const dappBytes32 = ethers.utils.hexZeroPad(transactDapp, 32);

    const rpcUrl = process.env.RPC_URL;
    const pk = process.env.PRIVATE_KEY;
    if (!rpcUrl || !pk) {
      throw new Error("RPC_URL and PRIVATE_KEY env vars are required for --transact");
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(pk, provider);

    const guard = new ethers.Contract(
      guardAddress,
      ["function whitelistEIP712(bytes32 dapp, bytes32 domainSeparator, (uint8[] directives, bytes dictionary)[] directivesArray) external"],
      wallet
    );

    console.log(`Sending whitelistEIP712 to ${guard.address} as ${await wallet.getAddress()}...`);
    const tx = await guard.whitelistEIP712(dappBytes32, domainSeparator, [
      { directives, dictionary: dictionaryHex }
    ]);
    const receipt = await tx.wait();
    console.log(`Transaction hash: ${receipt.transactionHash}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
