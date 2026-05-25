/**
 * pact-arc-demo — drives the deployed Pact protocol on Arc Testnet end-to-end.
 *
 * What's real: every transaction is a real Arc Testnet tx against the
 * verified contracts at:
 *   PactRegistry 0x056BAC33546b5b51B8CF6f332379651f715B889C
 *   PactPool     0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE
 *   PactSettler  0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f
 *
 * What's stubbed: the agent EOA and the SettlementEvent payload (latency,
 * breach flag, refund amount) come from this script, not from an automated
 * facilitator. The facilitator is the next milestone (and the grant's
 * Milestone 1 scope).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  zeroAddress,
  formatUnits,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { cfg, loadKeys, explorerTx, explorerAddr } from "./config.js";
import { slugToBytes16, randomCallId, fmtUsdc, step, ok, info, warn } from "./util.js";
import { PactRegistryAbi } from "./abi/PactRegistry.js";
import { PactPoolAbi } from "./abi/PactPool.js";
import { PactSettlerAbi } from "./abi/PactSettler.js";

const SETTLER_ROLE = keccak256(toBytes("SETTLER_ROLE"));
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

interface Wallets {
  authority: ReturnType<typeof privateKeyToAccount>;
  settler: ReturnType<typeof privateKeyToAccount>;
  agent: ReturnType<typeof privateKeyToAccount>;
  affiliate: Address;
}

interface Ctx {
  pub: PublicClient;
  authority: WalletClient;
  settler: WalletClient;
  agent: WalletClient;
  wallets: Wallets;
  preflightOnly: boolean;
}

function makeWallet(account: ReturnType<typeof privateKeyToAccount>): WalletClient {
  return createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
}

async function buildCtx(preflightOnly: boolean): Promise<Ctx> {
  const k = loadKeys();
  const wallets: Wallets = {
    authority: privateKeyToAccount(k.authority),
    settler: privateKeyToAccount(k.settler),
    agent: privateKeyToAccount(k.agent),
    affiliate: (k.affiliate || privateKeyToAccount(k.authority).address) as Address,
  };
  const pub = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  return {
    pub,
    authority: makeWallet(wallets.authority),
    settler: makeWallet(wallets.settler),
    agent: makeWallet(wallets.agent),
    wallets,
    preflightOnly,
  };
}

async function usdcBalance(ctx: Ctx, who: Address): Promise<bigint> {
  return (await ctx.pub.readContract({
    address: cfg.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

async function preflight(ctx: Ctx): Promise<void> {
  step(0, "Pre-flight");
  const block = await ctx.pub.getBlock();
  info(`chain id ${cfg.chain.id} block ${block.number} ts ${block.timestamp}`);

  const decimals = (await ctx.pub.readContract({
    address: cfg.usdc,
    abi: ERC20_ABI,
    functionName: "decimals",
  })) as number;
  if (decimals !== 6) throw new Error(`USDC decimals != 6 (got ${decimals}); refusing`);
  ok(`USDC decimals == 6`);

  const paused = (await ctx.pub.readContract({
    address: cfg.registry,
    abi: PactRegistryAbi,
    functionName: "protocolPaused",
  })) as boolean;
  if (paused) throw new Error("Protocol is paused; refusing");
  ok(`protocol not paused`);

  const authorityOnChain = (await ctx.pub.readContract({
    address: cfg.registry,
    abi: PactRegistryAbi,
    functionName: "authority",
  })) as Address;
  const authMatch = authorityOnChain.toLowerCase() === ctx.wallets.authority.address.toLowerCase();
  info(`registry.authority() = ${authorityOnChain}`);
  info(`AUTHORITY_PRIVATE_KEY ─→ ${ctx.wallets.authority.address}`);
  if (!authMatch) {
    warn(`AUTHORITY key does NOT match registry.authority(). Registration / role-grant steps will fail.`);
  } else {
    ok(`AUTHORITY key matches registry.authority()`);
  }

  const balances = await Promise.all([
    usdcBalance(ctx, ctx.wallets.authority.address),
    usdcBalance(ctx, ctx.wallets.settler.address),
    usdcBalance(ctx, ctx.wallets.agent.address),
  ]);
  info(`AUTHORITY USDC: ${fmtUsdc(balances[0])}  (${explorerAddr(ctx.wallets.authority.address)})`);
  info(`SETTLER   USDC: ${fmtUsdc(balances[1])}  (${explorerAddr(ctx.wallets.settler.address)})`);
  info(`AGENT     USDC: ${fmtUsdc(balances[2])}  (${explorerAddr(ctx.wallets.agent.address)})`);

  const need = {
    authority: cfg.topUp + 200_000n,
    settler: 100_000n,
    agent: cfg.premium * 3n + 100_000n,
  };
  const shortfalls: string[] = [];
  if (balances[0] < need.authority) shortfalls.push(`AUTHORITY needs ${fmtUsdc(need.authority - balances[0])} more`);
  if (balances[1] < need.settler) shortfalls.push(`SETTLER needs ${fmtUsdc(need.settler - balances[1])} more`);
  if (balances[2] < need.agent) shortfalls.push(`AGENT needs ${fmtUsdc(need.agent - balances[2])} more`);
  if (shortfalls.length > 0) {
    warn(`USDC shortfalls detected:`);
    shortfalls.forEach((s) => warn(`  ${s}`));
    warn(`Faucet: https://faucet.circle.com/  (drip USDC to each wallet on Arc Testnet)`);
    if (!ctx.preflightOnly) throw new Error("Insufficient USDC to run the demo; top up via faucet and retry");
  } else {
    ok(`all three wallets have sufficient USDC for the demo`);
  }
}

async function ensureEndpointRegistered(ctx: Ctx): Promise<Hex> {
  step(1, `registerEndpoint(${cfg.demoSlug})`);
  const slug = slugToBytes16(cfg.demoSlug);
  info(`slug bytes16 = ${slug}`);

  const isReg = (await ctx.pub.readContract({
    address: cfg.registry,
    abi: PactRegistryAbi,
    functionName: "isRegistered",
    args: [slug],
  })) as boolean;
  if (isReg) {
    ok(`endpoint already registered — skipping`);
    return slug;
  }

  info(`endpoint not registered — calling registerEndpoint as AUTHORITY`);
  const emptyRecipient = { kind: 0, destination: zeroAddress, bps: 0 };
  const emptyRecipients = [
    emptyRecipient, emptyRecipient, emptyRecipient, emptyRecipient,
    emptyRecipient, emptyRecipient, emptyRecipient, emptyRecipient,
  ] as const;
  const hash = await ctx.authority.writeContract({
    address: cfg.registry,
    abi: PactRegistryAbi,
    functionName: "registerEndpoint",
    args: [
      slug,
      0n,           // flatPremium (per-call premium comes from the SettlementEvent)
      0,            // percentBps
      2000,         // slaLatencyMs (2s SLA: PASS < 2000ms, BREACH >= 2000ms)
      0n,           // imputedCost
      1_000_000n,   // exposureCapPerHour (1 USDC/hour refund cap for demo safety)
      false,        // feeRecipientsPresent (use default Treasury template)
      0,            // feeRecipientCount
      emptyRecipients,
    ],
    account: ctx.wallets.authority,
    chain: cfg.chain,
  });
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`registerEndpoint reverted (tx ${hash})`);
  ok(`registered — ${explorerTx(hash)}`);
  return slug;
}

async function ensureSettlerRole(ctx: Ctx): Promise<void> {
  step(2, "grantRole(SETTLER_ROLE, SETTLER) on Registry + Settler");
  const settlerAddr = ctx.wallets.settler.address;

  const [hasOnRegistry, hasOnSettler] = await Promise.all([
    ctx.pub.readContract({
      address: cfg.registry,
      abi: PactRegistryAbi,
      functionName: "hasRole",
      args: [SETTLER_ROLE, settlerAddr],
    }) as Promise<boolean>,
    ctx.pub.readContract({
      address: cfg.settler,
      abi: PactSettlerAbi,
      functionName: "hasRole",
      args: [SETTLER_ROLE, settlerAddr],
    }) as Promise<boolean>,
  ]);

  if (hasOnRegistry) ok(`SETTLER already has SETTLER_ROLE on Registry`);
  else {
    const hash = await ctx.authority.writeContract({
      address: cfg.registry,
      abi: PactRegistryAbi,
      functionName: "grantRole",
      args: [SETTLER_ROLE, settlerAddr],
      account: ctx.wallets.authority,
      chain: cfg.chain,
    });
    await ctx.pub.waitForTransactionReceipt({ hash });
    ok(`granted on Registry — ${explorerTx(hash)}`);
  }

  if (hasOnSettler) ok(`SETTLER already has SETTLER_ROLE on Settler`);
  else {
    const hash = await ctx.authority.writeContract({
      address: cfg.settler,
      abi: PactSettlerAbi,
      functionName: "grantRole",
      args: [SETTLER_ROLE, settlerAddr],
      account: ctx.wallets.authority,
      chain: cfg.chain,
    });
    await ctx.pub.waitForTransactionReceipt({ hash });
    ok(`granted on Settler — ${explorerTx(hash)}`);
  }
}

async function ensurePoolFunded(ctx: Ctx, slug: Hex): Promise<void> {
  step(3, `topUp(${cfg.demoSlug}, ${fmtUsdc(cfg.topUp)})`);
  const before = (await ctx.pub.readContract({
    address: cfg.pool,
    abi: PactPoolAbi,
    functionName: "balanceOf",
    args: [slug],
  })) as { currentBalance: bigint };
  info(`pool currentBalance = ${fmtUsdc(before.currentBalance)}`);

  if (before.currentBalance >= cfg.topUp) {
    ok(`pool already funded ≥ ${fmtUsdc(cfg.topUp)} — skipping`);
    return;
  }

  const allowance = (await ctx.pub.readContract({
    address: cfg.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.wallets.authority.address, cfg.pool],
  })) as bigint;
  if (allowance < cfg.topUp) {
    const approveHash = await ctx.authority.writeContract({
      address: cfg.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [cfg.pool, cfg.topUp],
      account: ctx.wallets.authority,
      chain: cfg.chain,
    });
    await ctx.pub.waitForTransactionReceipt({ hash: approveHash });
    ok(`USDC approve(pool, ${fmtUsdc(cfg.topUp)}) — ${explorerTx(approveHash)}`);
  } else {
    ok(`USDC allowance already sufficient`);
  }

  const hash = await ctx.authority.writeContract({
    address: cfg.pool,
    abi: PactPoolAbi,
    functionName: "topUp",
    args: [slug, cfg.topUp],
    account: ctx.wallets.authority,
    chain: cfg.chain,
  });
  await ctx.pub.waitForTransactionReceipt({ hash });
  ok(`topUp — ${explorerTx(hash)}`);
}

async function ensureAgentApprovedSettler(ctx: Ctx): Promise<void> {
  step(4, "AGENT approves Settler to pull premium");
  const budget = cfg.premium * 3n;
  const allowance = (await ctx.pub.readContract({
    address: cfg.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ctx.wallets.agent.address, cfg.settler],
  })) as bigint;
  if (allowance >= budget) {
    ok(`agent already approved settler for ≥ ${fmtUsdc(budget)}`);
    return;
  }
  const hash = await ctx.agent.writeContract({
    address: cfg.usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [cfg.settler, budget],
    account: ctx.wallets.agent,
    chain: cfg.chain,
  });
  await ctx.pub.waitForTransactionReceipt({ hash });
  ok(`approved ${fmtUsdc(budget)} — ${explorerTx(hash)}`);
}

interface SettleResult {
  hash: Hex;
  callId: Hex;
  decoded: {
    premium: bigint;
    refund: bigint;
    actualRefund: bigint;
    status: number;
    breach: boolean;
    latencyMs: number;
  } | null;
}

async function settleOne(
  ctx: Ctx,
  slug: Hex,
  callId: Hex,
  opts: { premium: bigint; refund: bigint; latencyMs: number; breach: boolean },
  expectRevert: boolean,
): Promise<SettleResult> {
  const block = await ctx.pub.getBlock();
  const ts = block.timestamp - 30n;
  const event = {
    callId,
    agent: ctx.wallets.agent.address,
    endpointSlug: slug,
    premium: opts.premium,
    refund: opts.refund,
    latencyMs: opts.latencyMs,
    breach: opts.breach,
    feeRecipientCountHint: 0,
    timestamp: ts,
  };

  if (expectRevert) {
    try {
      await ctx.pub.simulateContract({
        address: cfg.settler,
        abi: PactSettlerAbi,
        functionName: "settleBatch",
        args: [[event]],
        account: ctx.wallets.settler.address,
      });
      throw new Error("expected revert but simulation succeeded");
    } catch (e: unknown) {
      const err = e as Error;
      if (err.message.includes("DuplicateCallId") || err.message.includes("0x4999df69")) {
        ok(`expected revert: DuplicateCallId (selector 0x4999df69)`);
        return { hash: "0x" as Hex, callId, decoded: null };
      }
      throw e;
    }
  }

  const hash = await ctx.settler.writeContract({
    address: cfg.settler,
    abi: PactSettlerAbi,
    functionName: "settleBatch",
    args: [[event]],
    account: ctx.wallets.settler,
    chain: cfg.chain,
  });
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`settleBatch reverted (tx ${hash})`);

  let decoded: SettleResult["decoded"] = null;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== cfg.settler.toLowerCase()) continue;
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
    } catch {
      // not a Settler event
    }
  }
  ok(`settled — ${explorerTx(hash)}`);
  if (decoded) {
    info(`premium=${fmtUsdc(decoded.premium)} refund=${fmtUsdc(decoded.refund)} actualRefund=${fmtUsdc(decoded.actualRefund)} status=${decoded.status} breach=${decoded.breach} latency=${decoded.latencyMs}ms`);
  }
  return { hash, callId, decoded };
}

async function main(): Promise<void> {
  const preflightOnly = process.argv.includes("--preflight-only");
  const ctx = await buildCtx(preflightOnly);

  console.log(`\nPact Network — Arc Testnet protocol demo`);
  console.log(`Chain id: ${cfg.chain.id}  RPC: ${cfg.rpcUrl}`);
  console.log(`Registry: ${explorerAddr(cfg.registry)}`);
  console.log(`Pool:     ${explorerAddr(cfg.pool)}`);
  console.log(`Settler:  ${explorerAddr(cfg.settler)}`);

  await preflight(ctx);
  if (preflightOnly) {
    console.log(`\nPre-flight only — exiting before any state change.`);
    return;
  }

  const slug = await ensureEndpointRegistered(ctx);
  await ensureSettlerRole(ctx);
  await ensurePoolFunded(ctx, slug);
  await ensureAgentApprovedSettler(ctx);

  const passId = randomCallId();
  const breachId = randomCallId();

  step(5, "settleBatch — PASS path (latency 500ms < 2000ms SLA, no breach)");
  const passResult = await settleOne(
    ctx,
    slug,
    passId,
    { premium: cfg.premium, refund: 0n, latencyMs: 500, breach: false },
    false,
  );

  step(6, "settleBatch — BREACH path (latency 3000ms > 2000ms SLA, refund paid)");
  const breachResult = await settleOne(
    ctx,
    slug,
    breachId,
    { premium: cfg.premium, refund: cfg.breachRefund, latencyMs: 3000, breach: true },
    false,
  );

  step(7, "settleBatch — REPLAY (same callId as PASS, expect DuplicateCallId revert)");
  await settleOne(
    ctx,
    slug,
    passId,
    { premium: cfg.premium, refund: 0n, latencyMs: 500, breach: false },
    true,
  );

  step(8, "Pool state after demo");
  const pool = (await ctx.pub.readContract({
    address: cfg.pool,
    abi: PactPoolAbi,
    functionName: "balanceOf",
    args: [slug],
  })) as {
    currentBalance: bigint;
    totalDeposits: bigint;
    totalPremiums: bigint;
    totalRefunds: bigint;
    createdAt: bigint;
  };
  info(`currentBalance = ${fmtUsdc(pool.currentBalance)}`);
  info(`totalDeposits  = ${fmtUsdc(pool.totalDeposits)}`);
  info(`totalPremiums  = ${fmtUsdc(pool.totalPremiums)}`);
  info(`totalRefunds   = ${fmtUsdc(pool.totalRefunds)}`);

  console.log(`\nDONE. Tx evidence:`);
  console.log(`  PASS    callId ${passResult.callId}  ${explorerTx(passResult.hash)}`);
  console.log(`  BREACH  callId ${breachResult.callId} ${explorerTx(breachResult.hash)}`);
  console.log(`  REPLAY  (reverted DuplicateCallId; not on-chain)`);
  console.log(`\nDashboard:`);
  console.log(`  pnpm dashboard  →  http://localhost:8910/?slug=${encodeURIComponent(cfg.demoSlug)}`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
