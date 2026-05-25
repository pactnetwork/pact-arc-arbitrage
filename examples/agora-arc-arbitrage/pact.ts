/**
 * Thin wrappers around the deployed Pact contracts on Arc.
 *
 * NOTE on the "purchase vs settle" two-step:
 * The current PactSettler.settleBatch is a single-call SettlementEvent
 * design — premium is pulled from the agent at settle time, not at purchase
 * time. So `purchaseInsurance` here is a *logical* commit: it locks in the
 * callId and verifies the slug + allowance on-chain, but doesn't actually
 * move USDC until `settleCall` fires. This matches src/demo.ts. When the
 * facilitator lands (grant Milestone 1) the two-step gets a real on-chain
 * reservation step.
 */
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { PactRegistryAbi } from "../../src/abi/PactRegistry.js";
import { PactPoolAbi } from "../../src/abi/PactPool.js";
import { PactSettlerAbi } from "../../src/abi/PactSettler.js";
import { slugToBytes16, randomCallId } from "../../src/util.js";

const ERC20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const SETTLER_ROLE: Hex = keccak256(toBytes("SETTLER_ROLE"));

interface PactCtx {
  pub: PublicClient;
  chain: Chain;
  registry: Address;
  pool: Address;
  settler: Address;
  usdc: Address;
}

/** Idempotent: if the slug is already registered, returns its bytes16 without sending a tx. */
export async function registerCCTPSlug(args: PactCtx & {
  authority: WalletClient;
  slug: string;
  slaLatencyMs: number;
  exposureCapPerHour: bigint;
}): Promise<Hex> {
  const { pub, chain, registry, authority, slug, slaLatencyMs, exposureCapPerHour } = args;
  if (!authority.account) throw new Error("authority walletClient has no account");

  const slugBytes = slugToBytes16(slug);
  const isReg = (await pub.readContract({
    address: registry, abi: PactRegistryAbi, functionName: "isRegistered", args: [slugBytes],
  })) as boolean;
  if (isReg) return slugBytes;

  const empty = { kind: 0, destination: zeroAddress, bps: 0 };
  const recipients = [empty, empty, empty, empty, empty, empty, empty, empty] as const;
  const hash = await authority.writeContract({
    address: registry,
    abi: PactRegistryAbi,
    functionName: "registerEndpoint",
    args: [slugBytes, 0n, 0, slaLatencyMs, 0n, exposureCapPerHour, false, 0, recipients],
    account: authority.account,
    chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`registerEndpoint reverted (tx ${hash})`);
  return slugBytes;
}

/** Tops up pool to >= minBalance. Approves USDC if needed. Idempotent. */
export async function ensurePoolTopUp(args: PactCtx & {
  authority: WalletClient;
  slug: Hex;
  minBalance: bigint;
  topUp: bigint;
}): Promise<void> {
  const { pub, chain, pool, usdc, authority, slug, minBalance, topUp } = args;
  if (!authority.account) throw new Error("authority walletClient has no account");

  const balance = (await pub.readContract({
    address: pool, abi: PactPoolAbi, functionName: "balanceOf", args: [slug],
  })) as { currentBalance: bigint };
  if (balance.currentBalance >= minBalance) return;

  const allowance = (await pub.readContract({
    address: usdc, abi: ERC20Abi, functionName: "allowance", args: [authority.account.address, pool],
  })) as bigint;
  if (allowance < topUp) {
    const ah = await authority.writeContract({
      address: usdc, abi: ERC20Abi, functionName: "approve", args: [pool, topUp],
      account: authority.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: ah });
  }
  const hash = await authority.writeContract({
    address: pool, abi: PactPoolAbi, functionName: "topUp", args: [slug, topUp],
    account: authority.account, chain,
  });
  await pub.waitForTransactionReceipt({ hash });
}

/** Grants SETTLER_ROLE on Registry + Settler if missing. Idempotent. */
export async function ensureSettlerRole(args: PactCtx & {
  authority: WalletClient;
  settlerAddress: Address;
}): Promise<void> {
  const { pub, chain, registry, settler, authority, settlerAddress } = args;
  if (!authority.account) throw new Error("authority walletClient has no account");

  const [onReg, onSet] = await Promise.all([
    pub.readContract({
      address: registry, abi: PactRegistryAbi, functionName: "hasRole",
      args: [SETTLER_ROLE, settlerAddress],
    }) as Promise<boolean>,
    pub.readContract({
      address: settler, abi: PactSettlerAbi, functionName: "hasRole",
      args: [SETTLER_ROLE, settlerAddress],
    }) as Promise<boolean>,
  ]);

  if (!onReg) {
    const h = await authority.writeContract({
      address: registry, abi: PactRegistryAbi, functionName: "grantRole",
      args: [SETTLER_ROLE, settlerAddress], account: authority.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  if (!onSet) {
    const h = await authority.writeContract({
      address: settler, abi: PactSettlerAbi, functionName: "grantRole",
      args: [SETTLER_ROLE, settlerAddress], account: authority.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
}

/**
 * Logical purchase: ensures the agent has approved Settler to pull `premium`,
 * then returns a fresh callId. No on-chain commit until settleCall fires.
 * See file-level note for why.
 */
export async function purchaseInsurance(args: PactCtx & {
  agent: WalletClient;
  premium: bigint;
}): Promise<Hex> {
  const { pub, chain, settler, usdc, agent, premium } = args;
  if (!agent.account) throw new Error("agent walletClient has no account");

  const allowance = (await pub.readContract({
    address: usdc, abi: ERC20Abi, functionName: "allowance",
    args: [agent.account.address, settler],
  })) as bigint;
  if (allowance < premium) {
    const ah = await agent.writeContract({
      address: usdc, abi: ERC20Abi, functionName: "approve",
      args: [settler, premium * 4n], // headroom so we don't re-approve every run
      account: agent.account, chain,
    });
    await pub.waitForTransactionReceipt({ hash: ah });
  }
  return randomCallId();
}

export interface SettleCallResult {
  txHash: Hex;
  decoded: {
    premium: bigint; refund: bigint; actualRefund: bigint;
    status: number; breach: boolean; latencyMs: number;
  } | null;
}

/** Submit a single-event settle batch and decode the CallSettled event. */
export async function settleCall(args: PactCtx & {
  settlerWallet: WalletClient;
  agentAddress: Address;
  slug: Hex;
  callId: Hex;
  premium: bigint;
  refund: bigint;
  latencyMs: number;
  breach: boolean;
}): Promise<SettleCallResult> {
  const {
    pub, chain, settler, settlerWallet, agentAddress, slug, callId, premium, refund, latencyMs, breach,
  } = args;
  if (!settlerWallet.account) throw new Error("settlerWallet has no account");
  if (latencyMs < 0 || latencyMs > 0xffffffff) {
    throw new Error(`latencyMs ${latencyMs} out of uint32 range`);
  }

  const block = await pub.getBlock();
  const event = {
    callId, agent: agentAddress, endpointSlug: slug,
    premium, refund, latencyMs, breach,
    feeRecipientCountHint: 0,
    timestamp: block.timestamp - 30n, // slight backdate satisfies InvalidTimestamp guard
  };

  const txHash = await settlerWallet.writeContract({
    address: settler, abi: PactSettlerAbi, functionName: "settleBatch",
    args: [[event]], account: settlerWallet.account, chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash: txHash });
  if (r.status !== "success") throw new Error(`settleBatch reverted (tx ${txHash})`);

  let decoded: SettleCallResult["decoded"] = null;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== settler.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: PactSettlerAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "CallSettled") {
        const a = ev.args as Record<string, unknown>;
        decoded = {
          premium: a.premium as bigint,
          refund: a.refund as bigint,
          actualRefund: a.actualRefund as bigint,
          status: Number(a.status),
          breach: Boolean(a.breach),
          latencyMs: Number(a.latencyMs),
        };
        break;
      }
    } catch { /* not a Settler event */ }
  }
  return { txHash, decoded };
}

/** Reads pool stats for the slug — used for the final-state summary. */
export async function readPoolStats(
  pub: PublicClient, pool: Address, slug: Hex,
): Promise<{ currentBalance: bigint; totalPremiums: bigint; totalRefunds: bigint }> {
  const s = (await pub.readContract({
    address: pool, abi: PactPoolAbi, functionName: "balanceOf", args: [slug],
  })) as { currentBalance: bigint; totalPremiums: bigint; totalRefunds: bigint };
  return {
    currentBalance: s.currentBalance,
    totalPremiums: s.totalPremiums,
    totalRefunds: s.totalRefunds,
  };
}
