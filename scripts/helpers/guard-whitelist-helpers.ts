import { getAddress, getBytes, id, isAddress, isHexString } from "ethers";

export type EIP712DirectiveEntry = {
  directives: number[];
  dictionary: string;
};

export function parseDappId(value: string): string {
  if (value.startsWith("0x")) {
    if (!isHexString(value, 32)) {
      throw new Error("--dapp hex value must be bytes32");
    }
    return value;
  }

  return id(value);
}

export function parseTargetList(value: string): string[] {
  return parseCsv(value, "--targets").map((target) => {
    if (!isAddress(target)) {
      throw new Error(`invalid target address: ${target}`);
    }
    return getAddress(target);
  });
}

export function parseHexBytesList(value: string): string[] {
  return parseCsv(value, "--directives").map((directive) => requireHexBytes("directive", directive));
}

export function parseIndexList(value: string): bigint[] {
  return parseCsv(value, "--idx").map((index) => {
    try {
      const parsed = BigInt(index);
      if (parsed < 0n) throw new Error();
      return parsed;
    } catch {
      throw new Error(`invalid --idx value: ${index}`);
    }
  });
}

export function parseEIP712DirectiveEntries(value: string): EIP712DirectiveEntry[] {
  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("--directives must contain at least one entry");
  }

  return entries.map((entry) => {
    const parts = entry.split(",");
    if (parts.length !== 2) {
      throw new Error("Each EIP-712 directive entry must be 0x-directives,0x-dictionary");
    }

    const directivesHex = requireHexBytes("EIP-712 directives", parts[0].trim());
    const dictionary = requireHexBytes("EIP-712 dictionary", parts[1].trim());
    return {
      directives: Array.from(getBytes(directivesHex)),
      dictionary,
    };
  });
}

function parseCsv(value: string, name: string): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return items;
}

function requireHexBytes(name: string, value: string): string {
  if (!isHexString(value) || value.length % 2 !== 0) {
    throw new Error(`${name} must be hex bytes`);
  }
  return value;
}
