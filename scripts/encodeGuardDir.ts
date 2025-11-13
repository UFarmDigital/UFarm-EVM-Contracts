import { ethers } from "ethers";

/**
 * CLI tool to generate directive blobs for the Guard contract.
 *
 * Usage:
 *   npx ts-node generateDirectives.ts "methodSignature" "selfArgsCSV" "fromListArgsCSV"
 *
 * Example:
 *   npx ts-node generateDirectives.ts \
 *     "mint(uint256 amount, address token, address receiver)" \
 *     "receiver" \
 *     "token,receiver"
 */

function usage(): never {
  console.error(
    [
      "Usage: npx ts-node generateDirectives.ts \"methodSignature\" \"selfArgsCSV\" \"fromListArgsCSV\"",
      "Example:",
      "  npx ts-node generateDirectives.ts \"mint(uint256 amount, address token, address receiver)\" \"receiver\" \"token,receiver\""
    ].join("\n")
  );
  process.exit(1);
}

async function main() {
  const [, , methodSig, selfArgsCSV = "", fromListArgsCSV = ""] = process.argv;
  if (!methodSig) usage();

  const selfArgs = selfArgsCSV.split(",").map(s => s.trim()).filter(Boolean);
  const fromListArgs = fromListArgsCSV.split(",").map(s => s.trim()).filter(Boolean);

  console.log("selfArgs:", selfArgs);
  console.log("fromListArgs:", fromListArgs);

  // Interface and fragment
  const iface = new ethers.utils.Interface([`function ${methodSig}`]);
  const fnFragment = iface.getFunction(methodSig);

  // Selector bytes
  const selector = iface.getSighash(fnFragment);
  const selBytes = ethers.utils.arrayify(selector);

  console.log(`Selector: ${selector}`);

  // Directive types
  const TYPE_WILDCARD = 0;
  const TYPE_ANY = 1;
  const TYPE_SELF = 2;
  const TYPE_FROM_LIST = 3;
  const TYPE_EXACT = 4;

  const directives: number[] = [];
  let hasDynamic = false;

  // 1) Exact-match for selector (4 bytes)
  directives.push((TYPE_EXACT << 5) | (4 - 1), ...selBytes);

  // Helper to emit directives
  function emit(bytesCount: number, namePath: string) {
    let dirType = TYPE_WILDCARD;
    if (selfArgs.includes(namePath)) dirType = TYPE_SELF;
    else if (fromListArgs.includes(namePath)) dirType = TYPE_FROM_LIST;

    if (dirType === TYPE_WILDCARD) {
      let words = Math.ceil(bytesCount / 32);
      while (words > 0) {
        const chunk = Math.min(words, 32);
        directives.push((TYPE_WILDCARD << 5) | (chunk - 1));
        words -= chunk;
      }
    } else {
      directives.push((dirType << 5) | (bytesCount - 1));
    }
  }

  // Recursive input processor
  function processInput(input: any, prefix = "") {
    const path = prefix ? `${prefix}.${input.name}` : input.name;
    console.log(`Processing: ${path} of type ${input.type}.`);

    // Dynamic string/bytes
    if (input.type === "string" || input.type === "bytes") {
      hasDynamic = true;
      emit(32, path);

    // Array types
    } else if (/\[[0-9]*\]$/.test(input.type)) {
      const size = input.type.match(/\[(?<sz>[0-9]*)\]$/)!.groups!.sz;
      const isDynamic = size === "";
      hasDynamic ||= isDynamic;

      // Tuple array
      if (input.type.startsWith("tuple")) {
        if (!isDynamic) {
          // Fixed-size tuple array: iterate elements
          const count = parseInt(size, 10);
          for (let i = 0; i < count; i++) {
            for (const comp of input.components || []) {
              // Use [] placeholder for dynamic index
              processInput({ ...comp, name: `${input.name}[].${comp.name}` }, prefix);
            }
          }
        } else {
          // Dynamic tuple array: wildcard pointer
          emit(32, path);
        }

      } else {
        // Non-tuple arrays: wildcard entire span
        const byteSpan = isDynamic ? 32 : parseInt(size, 10) * 32;
        emit(byteSpan, path);
      }

    // Tuple types
    } else if (input.type.startsWith("tuple")) {
      for (const comp of input.components || []) {
        processInput(comp, path);
      }

    // Static types
    } else {
      emit(32, path);
    }
  }

  // Generate directives
  for (const input of fnFragment.inputs) {
    processInput(input);
  }

  // Append any-length wildcard at end if dynamic types were encountered
  if (hasDynamic) {
    directives.push((TYPE_ANY << 5));
  }

  // Compress wildcards
  const compressed: number[] = [];
  for (let i = 0; i < directives.length; ) {
    const header = directives[i];
    const dirType = header >> 5;
    const lengthField = (header & 0x3F) + 1;
    if (dirType === TYPE_WILDCARD) {
      let totalWords = 0;
      while (i < directives.length && (directives[i] >> 5) === TYPE_WILDCARD) {
        totalWords += (directives[i] & 0x3F) + 1;
        i++;
      }
      while (totalWords > 0) {
        const chunk = Math.min(totalWords, 32);
        compressed.push((TYPE_WILDCARD << 6) | (chunk - 1));
        totalWords -= chunk;
      }
    } else {
      // Copy header
      compressed.push(header);
      i++;
      // Copy body if exact-match
      if (dirType === TYPE_EXACT) {
        for (let j = 0; j < lengthField; j++) {
          compressed.push(directives[i + j]);
        }
        i += lengthField;
      }
    }
  }

  // Output
  console.log(ethers.utils.hexlify(compressed));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
