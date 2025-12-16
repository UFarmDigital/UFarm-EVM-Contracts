#!/usr/bin/env ts-node
import { ethers } from "ethers";

/**
 * Usage:
 *   ./validateDirective.ts <calldataHex> <directiveHex> [sender] [whitelistCSV]
 */
function usage(): never {
  console.error("Usage: ./validateDirective.ts <calldataHex> <directiveHex> [sender] [whitelistCSV]");
  process.exit(1);
}

const TYPE_WILDCARD_WORDS = 0;
const TYPE_ANY            = 1;
const TYPE_SELF           = 2;
const TYPE_FROM_LIST      = 3;
const TYPE_EXACT          = 4;
const TYPE_WILDCARD_BYTES = 5;

function norm(a: string) { return ethers.utils.getAddress(a); }

type ValidationSuccess = { success: true };
type ValidationFailure = {
  success: false;
  directiveType: string;
  directiveValue: string;
  directiveOffset: number;
  reason: string;
};
type ValidationResult = ValidationSuccess | ValidationFailure;

const DIRECTIVE_TYPE_LABELS: Record<number, string> = {
  [TYPE_WILDCARD_WORDS]: "TYPE_WILDCARD_WORDS",
  [TYPE_ANY]: "TYPE_ANY",
  [TYPE_SELF]: "TYPE_SELF",
  [TYPE_FROM_LIST]: "TYPE_FROM_LIST",
  [TYPE_EXACT]: "TYPE_EXACT",
  [TYPE_WILDCARD_BYTES]: "TYPE_WILDCARD_BYTES",
};

function renderDirectiveValue(dir: Uint8Array, offset: number, typ: number, span: number): string {
  const extra = typ === TYPE_EXACT ? span : 0;
  const end = Math.min(dir.length, offset + 1 + extra);
  return ethers.utils.hexlify(dir.slice(offset, end));
}

function renderBytes(buf: Uint8Array): string {
  return ethers.utils.hexlify(buf);
}

function failure(
  typ: number,
  dir: Uint8Array,
  offset: number,
  span: number,
  reason: string
): ValidationFailure {
  return {
    success: false,
    directiveType: DIRECTIVE_TYPE_LABELS[typ] ?? `UNKNOWN(${typ})`,
    directiveValue: renderDirectiveValue(dir, offset, typ, span),
    directiveOffset: offset,
    reason,
  };
}

function validateDirective(
  calldataHex: string,
  directiveHex: string,
  sender?: string,
  whitelistCSV?: string
): ValidationResult {
  const data = ethers.utils.arrayify(calldataHex);
  const dir  = ethers.utils.arrayify(directiveHex);
  const senderAddr = sender ? norm(sender) : undefined;
  const whitelist = whitelistCSV ? whitelistCSV.split(",").map(norm) : [];

  let dPtr = 0; // calldata pointer
  let bPtr = 0; // directive pointer

  while (bPtr < dir.length) {
    const directiveOffset = bPtr;
    const header = dir[bPtr++];
    const typ = header >> 5;
    const span = (header & 0x1f) + 1;

    switch (typ) {
      case TYPE_WILDCARD_WORDS: {
        const bytesToSkip = span * 32;
        if (dPtr + bytesToSkip > data.length) {
          return failure(typ, dir, directiveOffset, span, "calldata shorter than wildcard word span");
        }
        dPtr += bytesToSkip;
        break;
      }
      case TYPE_WILDCARD_BYTES: {
        if (dPtr + span > data.length) {
          return failure(typ, dir, directiveOffset, span, "calldata shorter than wildcard byte span");
        }
        dPtr += span;
        break;
      }
      case TYPE_ANY: {
        return { success: true }; // accept remainder
      }
      case TYPE_EXACT: {
        if (bPtr + span > dir.length) {
          return failure(typ, dir, directiveOffset, span, "directive shorter than declared exact bytes");
        }
        if (dPtr + span > data.length) {
          return failure(typ, dir, directiveOffset, span, "calldata shorter than exact match span");
        }
        const expected = dir.slice(bPtr, bPtr + span);
        const actual = data.slice(dPtr, dPtr + span);
        for (let i = 0; i < span; i++) {
          if (data[dPtr + i] !== dir[bPtr + i]) {
            return failure(
              typ,
              dir,
              directiveOffset,
              span,
              `calldata bytes do not match directive (expected ${renderBytes(expected)} got ${renderBytes(actual)})`
            );
          }
        }
        dPtr += span;
        bPtr += span;
        break;
      }
      case TYPE_SELF:
      case TYPE_FROM_LIST: {
        if (span !== 20 && span !== 32) {
          return failure(typ, dir, directiveOffset, span, "address directives must have a span of 20 or 32");
        }
        if (dPtr + span > data.length) {
          return failure(typ, dir, directiveOffset, span, "calldata shorter than address span");
        }

        // Extract 20 bytes (packed when span=20, padded when span=32 => last 20 bytes)
        let addrBytes: Uint8Array;
        if (span === 32) {
          addrBytes = data.slice(dPtr + 12, dPtr + 32);
        } else {
          addrBytes = data.slice(dPtr, dPtr + 20);
        }
        const addr = ethers.utils.getAddress(ethers.utils.hexlify(addrBytes));

        if (typ === TYPE_SELF) {
          if (!senderAddr || addr !== senderAddr) {
            const reason = !senderAddr
              ? `sender not provided but calldata contains address ${addr}`
              : `sender address mismatch (expected ${senderAddr} got ${addr})`;
            return failure(typ, dir, directiveOffset, span, reason);
          }
        } else {
          if (whitelist.length === 0) {
            return failure(typ, dir, directiveOffset, span, `whitelist is empty, calldata contains ${addr}`);
          }
          if (!whitelist.includes(addr)) {
            return failure(
              typ,
              dir,
              directiveOffset,
              span,
              `address ${addr} not present in whitelist [${whitelist.join(", ")}]`
            );
          }
        }
        dPtr += span;
        break;
      }
      default:
        return failure(typ, dir, directiveOffset, span, "unknown directive type");
    }
  }
  if (dPtr !== data.length) {
    return {
      success: false,
      directiveType: "END_OF_DIRECTIVES",
      directiveValue: "0x",
      directiveOffset: dir.length,
      reason: "calldata still has unmatched bytes after processing directives",
    };
  }
  return { success: true };
}

if (require.main === module) {
  const [, , calldataHex, directiveHex, senderArg, whitelistArg] = process.argv;
  if (!calldataHex || !directiveHex) usage();
  const result = validateDirective(calldataHex, directiveHex, senderArg, whitelistArg);
  console.log(result.success ? "ALLOWED" : "DENIED");
  if (!result.success) {
    console.error(
      `Failed directive type=${result.directiveType} value=${result.directiveValue} offset=${result.directiveOffset} reason=${result.reason}`
    );
  }
}

export { validateDirective };
