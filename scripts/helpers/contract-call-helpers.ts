import { FunctionFragment, Interface, ParamType, Result, getAddress, isHexString } from "ethers";

export type ContractCall = {
  data: string;
  fragment: FunctionFragment;
  iface: Interface;
  args: unknown[];
};

export function buildContractCall(execute: string, argsText: string | undefined, returnTypes: string): ContractCall {
  const functionAbi = buildFunctionAbi(execute, returnTypes);
  const iface = new Interface([functionAbi]);
  const fragment = iface.fragments.find((candidate) => candidate.type === "function");
  if (!(fragment instanceof FunctionFragment)) {
    throw new Error("Invalid function signature");
  }

  const args = parseArguments(argsText, fragment.inputs);
  return {
    data: iface.encodeFunctionData(fragment, args),
    fragment,
    iface,
    args,
  };
}

export function formatDecodedResult(call: ContractCall, returnData: string): string[] {
  const decoded = call.iface.decodeFunctionResult(call.fragment, returnData);
  return call.fragment.outputs.map((output, index) => {
    const label = output.name.length === 0 ? `return${index}` : output.name;
    return `${label}: ${formatValue(decoded[index], output)}`;
  });
}

function buildFunctionAbi(execute: string, returnTypes: string): string {
  const signature = execute.trim().replace(/^function\s+/u, "");
  const returns = returnTypes.trim();
  if (signature.length === 0) throw new Error("--execute cannot be empty");
  if (returns.length === 0) throw new Error("--return cannot be empty");
  return `function ${signature} view returns ${returns.startsWith("(") ? returns : `(${returns})`}`;
}

function parseArguments(argsText: string | undefined, inputs: readonly ParamType[]): unknown[] {
  const raw = argsText?.trim() ?? "";
  if (inputs.length === 0) {
    if (raw.length !== 0) throw new Error("--args passed for a method without inputs");
    return [];
  }
  if (raw.length === 0) throw new Error("--args is required for this method");

  const values = splitTopLevel(raw);
  if (values.length !== inputs.length) {
    throw new Error(`--args expected ${inputs.length} value(s), got ${values.length}`);
  }

  return values.map((value, index) => parseArgumentValue(value, inputs[index]));
}

function parseArgumentValue(rawValue: string, param: ParamType): unknown {
  const value = stripQuotes(rawValue.trim());
  if (param.baseType === "array") {
    const parsed = parseJsonValue(value, param.type);
    if (!Array.isArray(parsed)) throw new Error(`${param.name || param.type} must be an array`);
    return parsed.map((item) => parseJsonArgumentValue(item, param.arrayChildren));
  }
  if (param.baseType === "tuple") {
    return parseJsonTuple(value, param);
  }
  return parseScalarArgument(value, param);
}

function parseJsonArgumentValue(value: unknown, param: ParamType): unknown {
  if (param.baseType === "array") {
    if (!Array.isArray(value)) throw new Error(`${param.name || param.type} must be an array`);
    return value.map((item) => parseJsonArgumentValue(item, param.arrayChildren));
  }
  if (param.baseType === "tuple") {
    return parseJsonTupleValue(value, param);
  }
  return parseScalarArgument(String(value), param);
}

function parseJsonTuple(rawValue: string, param: ParamType): unknown {
  return parseJsonTupleValue(parseJsonValue(rawValue, param.type), param);
}

function parseJsonTupleValue(value: unknown, param: ParamType): unknown {
  if (Array.isArray(value)) {
    if (value.length !== param.components.length) {
      throw new Error(`${param.name || param.type} expected ${param.components.length} tuple value(s)`);
    }
    return value.map((item, index) => parseJsonArgumentValue(item, param.components[index]));
  }

  if (typeof value !== "object" || value === null) {
    throw new Error(`${param.name || param.type} must be a tuple object or array`);
  }

  const record = value as Record<string, unknown>;
  return param.components.map((component) => {
    if (component.name.length === 0 || !(component.name in record)) {
      throw new Error(`${param.name || param.type} missing tuple field ${component.name}`);
    }
    return parseJsonArgumentValue(record[component.name], component);
  });
}

function parseScalarArgument(value: string, param: ParamType): unknown {
  if (param.baseType === "address") return getAddress(value);
  if (param.baseType === "bool") return parseBool(value, param.name || param.type);
  if (param.baseType === "string") return value;
  if (param.baseType === "bytes" || /^bytes[0-9]+$/u.test(param.type))
    return parseBytes(value, param.name || param.type);
  if (/^u?int[0-9]*$/u.test(param.type)) return BigInt(value);
  return value;
}

function parseBool(value: string, name: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be a boolean`);
}

function parseBytes(value: string, name: string): string {
  if (!isHexString(value)) throw new Error(`${name} must be hex bytes`);
  return value;
}

function parseJsonValue(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;

  for (let i = 0; i < value.length; ++i) {
    const char = value[i];
    const previous = value[i - 1];

    if (quote !== undefined) {
      current += char;
      if (char === quote && previous !== "\\") quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") {
      depth++;
      current += char;
      continue;
    }
    if (char === "]" || char === "}" || char === ")") {
      depth--;
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (quote !== undefined || depth !== 0) throw new Error("--args has unbalanced quotes or brackets");
  parts.push(current.trim());
  return parts;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function formatValue(value: unknown, param: ParamType): string {
  if (value instanceof Result) return formatTuple(value, param);
  if (Array.isArray(value)) return `[${value.map((item) => formatAnyValue(item)).join(", ")}]`;
  return formatAnyValue(value);
}

function formatTuple(value: Result, param: ParamType): string {
  return `{${param.components
    .map((component, index) => {
      const label = component.name.length === 0 ? String(index) : component.name;
      return `${label}: ${formatAnyValue(value[index])}`;
    })
    .join(", ")}}`;
}

function formatAnyValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => formatAnyValue(item)).join(", ")}]`;
  if (value instanceof Result) return `[${value.map((item) => formatAnyValue(item)).join(", ")}]`;
  return String(value);
}
