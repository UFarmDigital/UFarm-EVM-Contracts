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

function validateDirective(
  calldataHex: string,
  directiveHex: string,
  sender?: string,
  whitelistCSV?: string
): boolean {
  const data = ethers.utils.arrayify(calldataHex);
  const dir  = ethers.utils.arrayify(directiveHex);
  const senderAddr = sender ? norm(sender) : undefined;
  const whitelist = whitelistCSV ? whitelistCSV.split(",").map(norm) : [];

  let dPtr = 0; // calldata pointer
  let bPtr = 0; // directive pointer

  while (bPtr < dir.length) {
    const header = dir[bPtr++];
    const typ = header >> 5;
    const span = (header & 0x1f) + 1;

    switch (typ) {
      case TYPE_WILDCARD_WORDS: {
        const bytesToSkip = span * 32;
        if (dPtr + bytesToSkip > data.length) return false;
        dPtr += bytesToSkip;
        break;
      }
      case TYPE_WILDCARD_BYTES: {
        if (dPtr + span > data.length) return false;
        dPtr += span;
        break;
      }
      case TYPE_ANY: {
        return true; // accept remainder
      }
      case TYPE_EXACT: {
        if (dPtr + span > data.length) return false;
        for (let i = 0; i < span; i++) {
          if (data[dPtr + i] !== dir[bPtr + i]) return false;
        }
        dPtr += span;
        bPtr += span;
        break;
      }
      case TYPE_SELF:
      case TYPE_FROM_LIST: {
        if (span !== 20 && span !== 32) return false;
        if (dPtr + span > data.length) return false;

        // Extract 20 bytes (packed when span=20, padded when span=32 => last 20 bytes)
        let addrBytes: Uint8Array;
        if (span === 32) {
          addrBytes = data.slice(dPtr + 12, dPtr + 32);
        } else {
          addrBytes = data.slice(dPtr, dPtr + 20);
        }
        const addr = ethers.utils.getAddress(ethers.utils.hexlify(addrBytes));

        if (typ === TYPE_SELF) {
          if (!senderAddr || addr !== senderAddr) return false;
        } else {
          if (whitelist.length === 0 || !whitelist.includes(addr)) return false;
        }
        dPtr += span;
        break;
      }
      default:
        return false; // unknown type
    }
  }
  return dPtr === data.length;
}

if (require.main === module) {
  const [, , calldataHex, directiveHex, senderArg, whitelistArg] = process.argv;
  if (!calldataHex || !directiveHex) usage();
  const ok = validateDirective(calldataHex, directiveHex, senderArg, whitelistArg);
  console.log(ok ? "ALLOWED" : "DENIED");
}

export { validateDirective };
