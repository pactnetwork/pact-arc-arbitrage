/**
 * CCTP v2 burn-and-mint helpers.
 *
 * - burnOnArc:    calls TokenMessengerV2.depositForBurn on Arc Testnet
 * - mintOnDest:   calls MessageTransmitterV2.receiveMessage on Base Sepolia
 *
 * ABI fragments are inlined here (we only need two functions + one event)
 * so we don't pull a full CCTP package dep just for the demo. Validated
 * against Circle's published ABI; see Circle docs:
 *   developers.circle.com/cctp/evm-smart-contracts
 */
import {
  decodeEventLog,
  keccak256,
  pad,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

// V2 signature includes maxFee + minFinalityThreshold vs V1's depositForBurn.
// maxFee=0 + minFinalityThreshold=1000 = Standard Transfer (~15min on Arc-outbound).
export const TokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
  "event MessageSent(bytes message)",
]);

export const MessageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
]);

export const ERC20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** EVM address -> bytes32 (left-padded with 12 zero bytes). Common CCTP gotcha. */
export function addressToBytes32(addr: Address): Hex {
  return pad(addr, { size: 32 });
}

export interface BurnResult {
  burnTxHash: Hex;
  /** the MessageV2 payload bytes the destination's MessageTransmitter expects */
  message: Hex;
  /** keccak256 of the message — handy for indexing/debugging */
  messageHash: Hex;
  blockNumber: bigint;
}

/**
 * Burn USDC on Arc and extract the CCTP MessageSent payload from the receipt.
 * Auto-approves TokenMessengerV2 to pull `amount` USDC if allowance is short.
 */
export async function burnOnArc(args: {
  pub: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  tokenMessenger: Address;
  usdc: Address;
  amount: bigint;
  destDomain: number;
  mintRecipient: Address;
}): Promise<BurnResult> {
  const { pub, wallet, chain, tokenMessenger, usdc, amount, destDomain, mintRecipient } = args;
  if (!wallet.account) throw new Error("walletClient has no account");

  const allowance = (await pub.readContract({
    address: usdc, abi: ERC20Abi, functionName: "allowance",
    args: [wallet.account.address, tokenMessenger],
  })) as bigint;
  if (allowance < amount) {
    const approveHash = await wallet.writeContract({
      address: usdc, abi: ERC20Abi, functionName: "approve",
      args: [tokenMessenger, amount],
      account: wallet.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }

  const zeroBytes32 = ("0x" + "00".repeat(32)) as Hex; // destinationCaller=0 = permissionless mint
  const burnTxHash = await wallet.writeContract({
    address: tokenMessenger,
    abi: TokenMessengerV2Abi,
    functionName: "depositForBurn",
    args: [amount, destDomain, addressToBytes32(mintRecipient), usdc, zeroBytes32, 0n, 1000],
    account: wallet.account,
    chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnTxHash });
  if (receipt.status !== "success") throw new Error(`depositForBurn reverted (tx ${burnTxHash})`);

  let message: Hex = "0x" as Hex;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: TokenMessengerV2Abi, data: log.data, topics: log.topics });
      if (decoded.eventName === "MessageSent") {
        message = (decoded.args as { message: Hex }).message;
        break;
      }
    } catch { /* not the MessageSent event */ }
  }

  return {
    burnTxHash,
    message,
    messageHash: message === ("0x" as Hex) ? ("0x" as Hex) : keccak256(message),
    blockNumber: receipt.blockNumber,
  };
}

export interface MintResult {
  mintTxHash: Hex;
  /** actually-minted amount (balanceOf delta) — captures any fee/rounding the dest minter applied */
  mintedAmount: bigint;
  blockNumber: bigint;
}

/** Submit the Iris-attested message to MessageTransmitterV2 on the destination chain. */
export async function mintOnDest(args: {
  pub: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  messageTransmitter: Address;
  usdc: Address;
  recipient: Address;
  message: Hex;
  attestation: Hex;
}): Promise<MintResult> {
  const { pub, wallet, chain, messageTransmitter, usdc, recipient, message, attestation } = args;
  if (!wallet.account) throw new Error("walletClient has no account");

  const mintTxHash = await wallet.writeContract({
    address: messageTransmitter,
    abi: MessageTransmitterV2Abi,
    functionName: "receiveMessage",
    args: [message, attestation],
    account: wallet.account,
    chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: mintTxHash });
  if (receipt.status !== "success") throw new Error(`receiveMessage reverted (tx ${mintTxHash})`);

  // Sum Transfer(0x0 -> recipient) events on the USDC token in this tx.
  // balanceOf delta is unreliable on Base Sepolia's public RPC fanout —
  // post-mint reads can land on a node that hasn't ingested the block yet.
  const usdcAddr = usdc.toLowerCase();
  const recipientLower = recipient.toLowerCase();
  let mintedAmount = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddr) continue;
    try {
      const decoded = decodeEventLog({ abi: ERC20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "Transfer") continue;
      const a = decoded.args as { from: Address; to: Address; value: bigint };
      if (a.from === "0x0000000000000000000000000000000000000000" &&
          a.to.toLowerCase() === recipientLower) {
        mintedAmount += a.value;
      }
    } catch { /* not a Transfer event */ }
  }

  return {
    mintTxHash,
    mintedAmount,
    blockNumber: receipt.blockNumber,
  };
}

export async function usdcBalance(pub: PublicClient, usdc: Address, who: Address): Promise<bigint> {
  return (await pub.readContract({
    address: usdc, abi: ERC20Abi, functionName: "balanceOf", args: [who],
  })) as bigint;
}
