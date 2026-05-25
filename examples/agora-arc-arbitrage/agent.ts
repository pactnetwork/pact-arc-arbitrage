/**
 * Agora-Arc arb agent — end-to-end demo.
 *
 *   Arc settles in 510ms. CCTP attestation takes ~15 minutes.
 *   That window is the product.
 *
 * Flow:
 *   1. Set up: register CCTP slug, grant Settler role, fund pool (idempotent).
 *   2. Detect a USDC price gap between Arc and Base Sepolia.
 *   3. Buy insurance (logical purchase — locks callId + premium approval).
 *   4. Burn USDC on Arc via TokenMessengerV2.depositForBurn.
 *   5. Poll Circle's Iris API until attestation is ready (~15min on Arc-outbound).
 *   6. Submit attestation to MessageTransmitterV2 on Base Sepolia → USDC minted.
 *   7. Compute slippage: did the actually-minted amount cover what we expected?
 *   8. Settle the call on PactSettler with breach/no-breach + actual refund.
 *
 * Read top-to-bottom. Every numbered STEP below maps to a hero log line.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { cfg, loadKeys, arcExplorerTx, baseExplorerTx } from "./config.js";
import { fmtUsdc, step, ok, info, warn } from "../../src/util.js";
import { pollAttestation, IrisDeadlineExceeded } from "./iris.js";
import { burnOnArc, mintOnDest, usdcBalance } from "./cctp.js";
import {
  registerCCTPSlug,
  ensureSettlerRole,
  ensurePoolTopUp,
  purchaseInsurance,
  settleCall,
  readPoolStats,
} from "./pact.js";
import { getPriceGap } from "./prices.js";

const tFromStart = (started: number) => `T+${((Date.now() - started) / 1000).toFixed(1)}s`;

// State emitter — feeds the dashboard at ../../dashboard/agora.html via state.json polling.
// See dashboard/AGORA-BUILD-STATUS.md for the contract.
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "state.json");

type DashState = {
  stage:
    | "idle" | "registering" | "registered" | "insuring"
    | "burning" | "attesting" | "minting" | "settling"
    | "settled_ok" | "settled_breach";
  label: string;
  notional: number | null;
  premium: number | null;
  slaThresholdBps: number;
  expectedMint: number | null;
  actualMint: number | null;
  burnStartedAt: number | null;          // unix seconds
  attestationCompletedMs: number | null; // ms elapsed since burn
  attestationTimedOut: boolean;
  settled: {
    callId: string;
    slug: string;
    premium: number;
    latencyMs: number;
    breach: boolean;
    actualRefund: number;
  } | null;
  tx: {
    registry: string | null;
    burn: string | null;
    mint: string | null;
    settle: string | null;
  };
};

let dashState: DashState = {
  stage: "idle",
  label: "starting",
  notional: null,
  premium: null,
  slaThresholdBps: 50,
  expectedMint: null,
  actualMint: null,
  burnStartedAt: null,
  attestationCompletedMs: null,
  attestationTimedOut: false,
  settled: null,
  tx: { registry: null, burn: null, mint: null, settle: null },
};

type DashPatch = Omit<Partial<DashState>, "tx"> & { tx?: Partial<DashState["tx"]> };

async function emit(patch: DashPatch): Promise<void> {
  dashState = {
    ...dashState,
    ...patch,
    tx: { ...dashState.tx, ...(patch.tx || {}) },
  };
  try {
    await writeFile(STATE_PATH, JSON.stringify(dashState, null, 2));
  } catch {
    // dashboard is best-effort; never block the agent on state write failure
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const keys = loadKeys();
  const accounts = {
    authority: privateKeyToAccount(keys.authority),
    settler: privateKeyToAccount(keys.settler),
    arcAgent: privateKeyToAccount(keys.arcAgent),
    baseAgent: privateKeyToAccount(keys.baseAgent),
  };

  const arcPub = createPublicClient({ chain: cfg.arc.chain, transport: http(cfg.arc.rpcUrl) });
  const basePub = createPublicClient({ chain: cfg.base.chain, transport: http(cfg.base.rpcUrl) });
  const authority = createWalletClient({ account: accounts.authority, chain: cfg.arc.chain, transport: http(cfg.arc.rpcUrl) });
  const settlerWallet = createWalletClient({ account: accounts.settler, chain: cfg.arc.chain, transport: http(cfg.arc.rpcUrl) });
  const arcAgent = createWalletClient({ account: accounts.arcAgent, chain: cfg.arc.chain, transport: http(cfg.arc.rpcUrl) });
  const baseAgent = createWalletClient({ account: accounts.baseAgent, chain: cfg.base.chain, transport: http(cfg.base.rpcUrl) });

  console.log(`\nPact Network — Agora-Arc arb agent`);
  console.log(`Arc:  chain ${cfg.arc.chain.id} via ${cfg.arc.rpcUrl}`);
  console.log(`Base: chain ${cfg.base.chain.id} via ${cfg.base.rpcUrl}`);
  console.log(`Agent (Arc):  ${accounts.arcAgent.address}`);
  console.log(`Agent (Base): ${accounts.baseAgent.address}`);

  const pactCtx = {
    pub: arcPub,
    chain: cfg.arc.chain,
    registry: cfg.arc.registry,
    pool: cfg.arc.pool,
    settler: cfg.arc.settler,
    usdc: cfg.arc.usdc,
  };

  await emit({
    stage: "registering",
    label: "registering CCTP slug + funding pool",
    notional: Number(cfg.demo.principal),
    premium: Number(cfg.demo.premium),
    slaThresholdBps: cfg.demo.slaThresholdBps,
    expectedMint: Number(cfg.demo.principal),
  });

  // === STEP 1: set up Pact endpoint (slug, role, pool) ===
  step(1, `Setup Pact endpoint "${cfg.demo.slug}" (idempotent)`);
  const slug = await registerCCTPSlug({
    ...pactCtx,
    authority,
    slug: cfg.demo.slug,
    slaLatencyMs: cfg.demo.slaLatencyMs,
    exposureCapPerHour: cfg.demo.principal + cfg.demo.premium, // one full insured arb per hour
  });
  ok(`slug bytes16 = ${slug}`);
  await ensureSettlerRole({ ...pactCtx, authority, settlerAddress: accounts.settler.address });
  ok(`settler role granted (or already present)`);
  await ensurePoolTopUp({
    ...pactCtx,
    authority,
    slug,
    minBalance: cfg.demo.principal + cfg.demo.premium,
    topUp: cfg.demo.poolTopUp,
  });
  ok(`pool funded`);

  // === STEP 2: price gap ===
  step(2, `Check Arc <-> Base Sepolia USDC price gap`);
  const gap = await getPriceGap();
  info(`Arc:  ${gap.arcPrice.toFixed(6)} USDC/USD`);
  info(`Base: ${gap.basePrice.toFixed(6)} USDC/USD`);
  info(`Gap:  ${gap.gapBps} bps`);
  if (gap.gapBps < 10) {
    warn(`Gap below 10bps — arb may not cover slippage tolerance. Continuing anyway for demo.`);
  }

  await emit({ stage: "registered", label: "pool funded, ready to insure" });

  // === STEP 3: insurance ===
  step(3, `Buy Pact insurance — premium ${fmtUsdc(cfg.demo.premium)}, principal ${fmtUsdc(cfg.demo.principal)}`);
  await emit({ stage: "insuring", label: "purchasing insurance" });
  const callId = await purchaseInsurance({ ...pactCtx, agent: arcAgent, premium: cfg.demo.premium });
  ok(`callId = ${callId}`);
  console.log(`[${tFromStart(startedAt)}] insured`);

  // === STEP 4: burn USDC on Arc ===
  step(4, `CCTP burn on Arc — depositForBurn(${fmtUsdc(cfg.demo.principal)}, domain=${cfg.cctp.baseDomain})`);
  await emit({ stage: "burning", label: "submitting CCTP burn on Arc" });
  const burnStartedAt = Date.now();
  const burn = await burnOnArc({
    pub: arcPub,
    wallet: arcAgent,
    chain: cfg.arc.chain,
    tokenMessenger: cfg.cctp.tokenMessenger,
    usdc: cfg.arc.usdc,
    amount: cfg.demo.principal,
    destDomain: cfg.cctp.baseDomain,
    mintRecipient: accounts.baseAgent.address as Address,
  });
  ok(`burn tx: ${arcExplorerTx(burn.burnTxHash)}`);
  console.log(`[${tFromStart(startedAt)}] burn submitted`);
  await emit({
    stage: "attesting",
    label: "CCTP burn submitted, polling Iris for attestation",
    burnStartedAt: Math.floor(burnStartedAt / 1000),
    tx: { burn: burn.burnTxHash },
  });

  // === STEP 5: poll Iris ===
  step(5, `Poll Iris for attestation (Arc->Base = standard ~15min)`);
  const deadline = Math.floor(Date.now() / 1000) + cfg.iris.pollTimeoutS;
  let attestation;
  try {
    attestation = await pollAttestation(cfg.cctp.arcDomain, burn.burnTxHash, deadline, {
      intervalMs: cfg.iris.pollIntervalMs,
      irisBase: cfg.iris.base,
      onPoll: (n) => {
        if (n % 12 === 0) info(`  ...still polling (poll #${n}, ${((Date.now() - burnStartedAt) / 1000).toFixed(0)}s elapsed)`);
      },
    });
  } catch (e) {
    if (e instanceof IrisDeadlineExceeded) {
      warn(e.message);
      warn(`Triggering BridgeTimeout settle path on Pact (full refund).`);
      const attestationLatencyMs = Date.now() - burnStartedAt;
      await emit({
        stage: "settling",
        label: "attestation deadline exceeded, settling BridgeTimeout",
        attestationTimedOut: true,
      });
      const timeoutSettle = await settleCall({
        ...pactCtx,
        settlerWallet,
        agentAddress: accounts.arcAgent.address as Address,
        slug,
        callId,
        premium: cfg.demo.premium,
        refund: cfg.demo.principal + cfg.demo.premium,
        latencyMs: Math.min(attestationLatencyMs, 0xffffffff),
        breach: true,
      });
      console.log(`\n[${tFromStart(startedAt)}] timeout-settled: ${arcExplorerTx(timeoutSettle.txHash)}`);
      await emit({
        stage: "settled_breach",
        label: "settled as BridgeTimeout — refund paid",
        tx: { settle: timeoutSettle.txHash },
        settled: {
          callId,
          slug,
          premium: Number(cfg.demo.premium),
          latencyMs: Math.min(attestationLatencyMs, 0xffffffff),
          breach: true,
          actualRefund: Number(cfg.demo.principal + cfg.demo.premium),
        },
      });
      return;
    }
    throw e;
  }
  const attestationLatencyMs = Date.now() - burnStartedAt;
  ok(`attestation received after ${(attestationLatencyMs / 1000).toFixed(1)}s (nonce=${attestation.eventNonce})`);
  await emit({
    stage: "minting",
    label: `attestation received at T+${(attestationLatencyMs / 1000).toFixed(0)}s, minting on Base`,
    attestationCompletedMs: attestationLatencyMs,
  });

  // === STEP 6: mint on Base Sepolia ===
  step(6, `Mint on Base Sepolia — MessageTransmitterV2.receiveMessage(...)`);
  const mint = await mintOnDest({
    pub: basePub,
    wallet: baseAgent,
    chain: cfg.base.chain,
    messageTransmitter: cfg.cctp.messageTransmitter,
    usdc: cfg.base.usdc,
    recipient: accounts.baseAgent.address as Address,
    message: attestation.message,
    attestation: attestation.attestation,
  });
  ok(`mint tx: ${baseExplorerTx(mint.mintTxHash)}`);
  info(`actually minted: ${fmtUsdc(mint.mintedAmount)} (expected ${fmtUsdc(cfg.demo.principal)})`);
  await emit({
    actualMint: Number(mint.mintedAmount),
    tx: { mint: mint.mintTxHash },
  });

  // === STEP 7: slippage + breach decision ===
  step(7, `Compute slippage + SLA decision`);
  const expected = cfg.demo.principal;
  // CCTP v2 with maxFee=0 (standard) should mint 1:1; any shortfall is fee or rounding.
  const slippageBps =
    mint.mintedAmount >= expected
      ? 0
      : Number(((expected - mint.mintedAmount) * 10000n) / expected);
  const latencyBreach = attestationLatencyMs > cfg.demo.slaLatencyMs;
  const slippageBreach = slippageBps > cfg.demo.slaThresholdBps;
  const breach = latencyBreach || slippageBreach;
  info(`slippage: ${slippageBps}bps (threshold ${cfg.demo.slaThresholdBps}bps)`);
  info(`latency:  ${attestationLatencyMs}ms (threshold ${cfg.demo.slaLatencyMs}ms)`);
  info(`breach:   ${breach}  (latencyBreach=${latencyBreach}, slippageBreach=${slippageBreach})`);

  // === STEP 8: settle on Pact ===
  step(8, `Settle call on PactSettler`);
  await emit({ stage: "settling", label: "submitting settle tx on Arc" });
  const refund = breach ? cfg.demo.principal + cfg.demo.premium : 0n;
  const settle = await settleCall({
    ...pactCtx,
    settlerWallet,
    agentAddress: accounts.arcAgent.address as Address,
    slug,
    callId,
    premium: cfg.demo.premium,
    refund,
    latencyMs: Math.min(attestationLatencyMs, 0xffffffff),
    breach,
  });
  ok(`settle tx: ${arcExplorerTx(settle.txHash)}`);
  if (settle.decoded) {
    info(
      `decoded: premium=${fmtUsdc(settle.decoded.premium)} refund=${fmtUsdc(settle.decoded.refund)} actualRefund=${fmtUsdc(settle.decoded.actualRefund)} status=${settle.decoded.status}`,
    );
  }
  await emit({
    stage: breach ? "settled_breach" : "settled_ok",
    label: breach ? "settled — refund paid" : "settled — premium retained, pool grew",
    tx: { settle: settle.txHash },
    settled: {
      callId,
      slug,
      premium: Number(settle.decoded?.premium ?? cfg.demo.premium),
      latencyMs: Math.min(attestationLatencyMs, 0xffffffff),
      breach,
      actualRefund: Number(settle.decoded?.actualRefund ?? refund),
    },
  });

  // === final state ===
  step(9, `Final state`);
  const pool = await readPoolStats(arcPub, cfg.arc.pool, slug);
  info(`pool.currentBalance = ${fmtUsdc(pool.currentBalance)}`);
  info(`pool.totalPremiums  = ${fmtUsdc(pool.totalPremiums)}`);
  info(`pool.totalRefunds   = ${fmtUsdc(pool.totalRefunds)}`);
  const arcUsdc = await usdcBalance(arcPub, cfg.arc.usdc, accounts.arcAgent.address as Address);
  const baseUsdc = await usdcBalance(basePub, cfg.base.usdc, accounts.baseAgent.address as Address);
  info(`agent USDC on Arc:  ${fmtUsdc(arcUsdc)}`);
  info(`agent USDC on Base: ${fmtUsdc(baseUsdc)}`);

  console.log(`\nDONE. Tx evidence:`);
  console.log(`  burn   ${arcExplorerTx(burn.burnTxHash)}`);
  console.log(`  mint   ${baseExplorerTx(mint.mintTxHash)}`);
  console.log(`  settle ${arcExplorerTx(settle.txHash)}`);
  console.log(`\nNarrative: Arc settles in 510ms. CCTP attestation took ${(attestationLatencyMs / 1000).toFixed(0)}s.`);
  console.log(`That window is the product.\n`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
