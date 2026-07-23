export const CROSS_CHAIN_ADAPTER_ID = "0xbb944973a96662d813f257218489b801244388f73c2250ff205f5d3771b8cb9b";

const CROSS_CHAIN_STORAGE_SLOT = 0x6f520b638d50cbe41699f6336ebce78b28cf648bd5326fe1f935fcb38e538700n;
const UINT64_MASK = (1n << 64n) - 1n;

export async function readCrossChainOutbox(ethers: any, vault: { getAddress(): Promise<string> }) {
  const vaultAddress = await vault.getAddress();
  const outboxSlot = CROSS_CHAIN_STORAGE_SLOT + 1n;
  const header = BigInt(await ethers.provider.getStorage(vaultAddress, outboxSlot));
  const messageHeader = BigInt(await ethers.provider.getStorage(vaultAddress, outboxSlot + 1n));
  const amount = BigInt(await ethers.provider.getStorage(vaultAddress, outboxSlot + 2n));

  return {
    exists: (header & 0xffn) !== 0n,
    targetChainId: (header >> 8n) & UINT64_MASK,
    nextState: (header >> 72n) & 0xffn,
    message: {
      version: messageHeader & 0xffffn,
      messageType: (messageHeader >> 16n) & 0xffn,
      sourceChainId: (messageHeader >> 24n) & UINT64_MASK,
      destinationChainId: (messageHeader >> 88n) & UINT64_MASK,
      sessionNonce: (messageHeader >> 152n) & UINT64_MASK,
      amount,
    },
  };
}
