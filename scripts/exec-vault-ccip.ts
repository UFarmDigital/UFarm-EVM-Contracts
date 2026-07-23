import { AbiCoder, Interface, ZeroAddress, getAddress, id, zeroPadValue } from "ethers";
import {
  argumentValue,
  connectWithRole,
  optionalAddressArgumentValue,
  optionalBytesArgument,
  optionalUintArgument,
  parseTokenAmountArgument,
  requiredAddressArgument,
  requiredUintArgument,
  waitAndLog,
} from "./helpers/exec-helpers.js";

const CROSS_CHAIN_ADAPTER_ID = id("ufarm.adapter.cross-chain");
const CROSS_CHAIN_IFACE = new Interface([
  "function crossChainTransfer(uint64 destinationChainId,uint256 amount)",
  "function manualResendCrossChainMessage()",
  "function manualResetCrossChainSession(uint64 targetChainId)",
]);
const MESSAGE_TYPES = {
  "transfer-request": 0,
  "transfer-approval": 1,
  "transfer-sent": 2,
  "transfer-receipt": 3,
  reset: 4,
} as const;
const SUPPORTED_ACTIONS = [
  "send-tokens",
  "resend",
  "reset",
  "incoming-transfer-request",
  "incoming-transfer-approval",
  "incoming-transfer-sent",
  "incoming-transfer-receipt",
  "incoming-reset",
] as const;

type MessageTypeName = keyof typeof MESSAGE_TYPES;

const vaultAddress = requiredAddressArgument("--vault");
const action = argumentValue("--action");
if (action === undefined) {
  throw new Error("--action is required");
}

if (action === "send-tokens" || action === "send" || action === "transfer") {
  const destinationChainId = requiredUintArgument("--destination-chain-id");
  const amount = parseTokenAmountArgument("--amount", 18);
  await executeCrossChainAdapter(
    CROSS_CHAIN_IFACE.encodeFunctionData("crossChainTransfer", [destinationChainId, amount]),
  );
} else if (action === "resend") {
  await executeCrossChainAdapter(CROSS_CHAIN_IFACE.encodeFunctionData("manualResendCrossChainMessage"));
} else if (action === "reset") {
  const targetChainId = requiredUintArgument("--target-chain-id");
  await executeCrossChainAdapter(CROSS_CHAIN_IFACE.encodeFunctionData("manualResetCrossChainSession", [targetChainId]));
} else {
  const messageType = parseIncomingMessageType(action);
  await deliverIncomingMessage(messageType);
}

async function executeCrossChainAdapter(data: string): Promise<void> {
  const { ethers } = await connectWithRole("PK_VAULT_OWNER");
  const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);
  const tx = await vault.executeAdapter(CROSS_CHAIN_ADAPTER_ID, data);

  console.log(`vault: ${vaultAddress}`);
  console.log(`adapterId: ${CROSS_CHAIN_ADAPTER_ID}`);
  await waitAndLog(tx);
}

async function deliverIncomingMessage(messageType: MessageTypeName): Promise<void> {
  const { ethers } = await connectWithRole("PK_UFARM_OWNER");
  const vault = await ethers.getContractAt("IUFarmVault", vaultAddress);
  const core = await ethers.getContractAt("IUFarmCore", await vault.core());
  const routerAddress = optionalAddressArgumentValue("--router") ?? (await core.crossChainRouter());
  if (routerAddress === ZeroAddress) {
    throw new Error("Core crossChainRouter is not configured; pass --router or configure core first");
  }

  const sourceChainId = requiredUintArgument("--source-chain-id");
  const destinationChainId = requiredUintArgument("--destination-chain-id");
  const nonce = requiredUintArgument("--nonce");
  const amount = messageType === "reset" ? optionalUintArgument("--amount", 0n) : requiredUintArgument("--amount");
  const accountingChainId = await core.accountingChainId();
  const expectedSourceChainId = expectedImmediateSourceChainId(
    messageType,
    sourceChainId,
    destinationChainId,
    accountingChainId,
  );
  const sourceChainSelector = optionalUintArgument(
    "--source-selector",
    await core.ccipSelectorForChain(expectedSourceChainId),
  );
  if (sourceChainSelector === 0n) {
    throw new Error(`No CCIP selector configured for chain ${expectedSourceChainId}`);
  }

  const sender = encodeSender(optionalAddressArgumentValue("--sender") ?? vaultAddress);
  const messageId = optionalBytesArgument("--message-id", id(`${vaultAddress}:${messageType}:${nonce}`));
  const data = AbiCoder.defaultAbiCoder().encode(
    ["uint16", "uint8", "uint64", "uint64", "uint64", "uint256"],
    [1, MESSAGE_TYPES[messageType], sourceChainId, destinationChainId, nonce, amount],
  );
  const destTokenAmounts =
    messageType === "transfer-sent"
      ? [{ token: await vault.asset(), amount: optionalUintArgument("--token-amount", amount) }]
      : [];

  const router = await ethers.getContractAt("MockCCIPRouter", routerAddress);
  const tx = await router.deliver(vaultAddress, {
    messageId,
    sourceChainSelector,
    sender,
    data,
    destTokenAmounts,
  });

  console.log(`vault: ${vaultAddress}`);
  console.log(`router: ${routerAddress}`);
  console.log(`messageType: ${messageType}`);
  console.log(`sourceChainSelector: ${sourceChainSelector}`);
  await waitAndLog(tx);
}

function parseIncomingMessageType(action: string): MessageTypeName {
  if (action === "incoming") {
    return requireMessageType(argumentValue("--message-type"));
  }
  if (action.startsWith("incoming-")) {
    return requireMessageType(action.slice("incoming-".length));
  }
  throw new Error(`Unsupported --action: ${action}. Supported actions: ${SUPPORTED_ACTIONS.join(", ")}`);
}

function requireMessageType(value: string | undefined): MessageTypeName {
  if (value === undefined || !(value in MESSAGE_TYPES)) {
    throw new Error(`--message-type must be one of: ${Object.keys(MESSAGE_TYPES).join(", ")}`);
  }
  return value as MessageTypeName;
}

function expectedImmediateSourceChainId(
  messageType: MessageTypeName,
  sourceChainId: bigint,
  destinationChainId: bigint,
  accountingChainId: bigint,
): bigint {
  if (messageType === "transfer-approval" || messageType === "reset") return accountingChainId;
  if (messageType === "transfer-receipt") return destinationChainId;
  return sourceChainId;
}

function encodeSender(sender: string): string {
  return zeroPadValue(getAddress(sender), 32);
}
