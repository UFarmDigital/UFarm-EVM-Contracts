#!/usr/bin/env ts-node
import { ethers } from "ethers";

/**
 * Usage:
 *   npx ts-node generateFromCalldata.ts <calldataHex> <selfAddress> [whitelistCSV] [exactCSV]
 *
 * Header format: [type (3 bits) | lengthMinus1 (5 bits)]
 * Types:
 *   0b000 (0) WILDCARD (fixed-length in 32-byte words)
 *   0b001 (1) ANY-length wildcard (unused here)
 *   0b010 (2) SELF address (length in BYTES: 20 or 32)
 *   0b011 (3) FROM_LIST address (length in BYTES: 20 or 32)
 *   0b100 (4) EXACT match (length in BYTES, followed by payload)
 *   0b101 (5) WILDCARD_BYTES (length in BYTES)
 */

const TYPE_WILDCARD = 0;
const TYPE_ANY = 1;
const TYPE_SELF = 2;
const TYPE_FROM_LIST = 3;
const TYPE_EXACT = 4;
const TYPE_WILDCARD_BYTES = 5;

const normalizeAddr = (a: string) => ethers.utils.getAddress(a);
const toHex = (b: Uint8Array) => ethers.utils.hexlify(b);

const mkHeader = (type: number, lengthMinus1: number) =>
  (type << 5) | (lengthMinus1 & 0x1f);

function generateDirectivesFromCalldata(
  calldataHex: string,
  selfAddress: string,
  whitelistCSV?: string,
  exactCSV?: string
): string {
  const data = ethers.utils.arrayify(calldataHex);
  if (data.length < 4) throw new Error("Calldata too short (<4 bytes).");

  const self = normalizeAddr(selfAddress);
  const wlArr = (whitelistCSV ? whitelistCSV.split(",") : []).map(normalizeAddr);
  const wlSet = new Set(wlArr);

  const exactPatterns: Uint8Array[] = (exactCSV ? exactCSV.split(",") : [])
    .filter((s) => s.length > 0)
    .map((hex) => ethers.utils.arrayify(hex));

  // Sort by length (longest first) so longer patterns win
  exactPatterns.sort((a, b) => b.length - a.length);

  const directives: number[] = [];

  // 1) EXACT selector (4 bytes)
  directives.push(mkHeader(TYPE_EXACT, 4 - 1), ...data.slice(0, 4));

  // Helpers to flush wildcard runs
  let pendingByteSkips = 0;
  const flushWildcards = () => {
    if (pendingByteSkips <= 0) return;
    const fullWords = Math.floor(pendingByteSkips / 32);
    const leftover = pendingByteSkips % 32;
    let wordsLeft = fullWords;
    while (wordsLeft > 0) {
      const chunk = Math.min(wordsLeft, 32);
      directives.push(mkHeader(TYPE_WILDCARD, chunk - 1));
      wordsLeft -= chunk;
    }
    if (leftover > 0) {
      directives.push(mkHeader(TYPE_WILDCARD_BYTES, leftover - 1));
    }
    pendingByteSkips = 0;
  };

  // 2) Scan the entire payload from offset 4
  let ptr = 4;
  const len = data.length;

  while (ptr < len) {
    // --- Exact pattern match
    let matchedExact: Uint8Array | null = null;
    for (const pat of exactPatterns) {
      if (ptr + pat.length <= len) {
        const slice = data.slice(ptr, ptr + pat.length);
        if (slice.every((b, i) => b === pat[i])) {
          matchedExact = pat;
          break;
        }
      }
    }
    if (matchedExact) {
      flushWildcards();
      directives.push(mkHeader(TYPE_EXACT, matchedExact.length - 1), ...matchedExact);
      ptr += matchedExact.length;
      continue;
    }

    // --- Padded address
    if (ptr + 32 <= len) {
      const slot = data.slice(ptr, ptr + 32);
      let isZeroPadded = true;
      for (let z = 0; z < 12; z++) if (slot[z] !== 0) { isZeroPadded = false; break; }
      if (isZeroPadded) {
        const addr = normalizeAddr(toHex(slot.slice(12)));
        const isSelf = addr === self;
        const isWL = !isSelf && wlSet.has(addr);
        if (isSelf || isWL) {
          flushWildcards();
          directives.push(mkHeader(isSelf ? TYPE_SELF : TYPE_FROM_LIST, 32 - 1));
          ptr += 32;
          continue;
        }
      }
    }

    // --- Packed address
    if (ptr + 20 <= len) {
      const slice20 = data.slice(ptr, ptr + 20);
      const addr = normalizeAddr(toHex(slice20));
      const isSelf = addr === self;
      const isWL = !isSelf && wlSet.has(addr);
      if (isSelf || isWL) {
        flushWildcards();
        directives.push(mkHeader(isSelf ? TYPE_SELF : TYPE_FROM_LIST, 20 - 1));
        ptr += 20;
        continue;
      }
    }

    // --- No match, accumulate wildcard
    pendingByteSkips += 1;
    ptr += 1;
  }

  // 3) Flush any trailing wildcards
  flushWildcards();

  return ethers.utils.hexlify(directives);
}

if (require.main === module) {
  const [, , calldataHex, selfAddr, whitelistCsv, exactCsv] = process.argv;
  if (!calldataHex || !selfAddr) {
    console.error(
      "Usage: npx ts-node generateFromCalldata.ts <calldataHex> <selfAddress> [whitelistCSV] [exactCSV]"
    );
    process.exit(1);
  }

  try {
    const blob = generateDirectivesFromCalldata(
      calldataHex,
      selfAddr,
      whitelistCsv,
      exactCsv
    );
    console.log(blob);
  } catch (e: any) {
    console.error(`Error: ${e.message || e}`);
    process.exit(1);
  }
}

export { generateDirectivesFromCalldata };
