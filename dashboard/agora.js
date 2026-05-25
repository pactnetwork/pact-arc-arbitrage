// Pact × Agora dashboard. Read-only.
// Two data sources:
//   1) Live agent state via ../examples/agora-arc-arbitrage/state.json (optional, polled 2s)
//   2) On-chain CallSettled events via Arc Testnet RPC (always, polled 8s via getLogs)

import {
  createPublicClient, http, formatUnits, decodeEventLog, hexToBytes,
} from "https://esm.sh/viem@2.21.0";

// --- config (mirrors src/config.ts + ../examples/agora-arc-arbitrage/config.ts) ---
// NOTE: addresses updated 2026-05-21 for Agora-redeploy under Rick's wallet.
const ARC_RPC = "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const REGISTRY = "0x60e51f2C8C162Ec13c7C7234fC9490936127F01B";
const POOL     = "0xC5D4c573828e998695b6bD5577947bC77A8f7F97";
const SETTLER  = "0xccf30140d74cc0D384800501506d50fe622Ae963";
const SCAN     = "https://testnet.arcscan.app";
const GITHUB   = "https://github.com/pact-network/pact-arc-demo";

// state.json is symlinked into the dashboard dir so this works whether the
// http.server runs from dashboard/ or from pact-arc-demo/ root.
const STATE_URL = "state.json";
const STATE_POLL_MS = 2000;
const CHAIN_POLL_MS = 8000;

// CallSettled event ABI (matches the deployed PactSettler).
const SETTLER_EVENT_ABI = [
  { type: "event", name: "CallSettled",
    inputs: [
      { name: "callId",       type: "bytes16", indexed: true },
      { name: "slug",         type: "bytes16", indexed: true },
      { name: "agent",        type: "address", indexed: true },
      { name: "premium",      type: "uint64",  indexed: false },
      { name: "refund",       type: "uint64",  indexed: false },
      { name: "actualRefund", type: "uint64",  indexed: false },
      { name: "status",       type: "uint8",   indexed: false },
      { name: "breach",       type: "bool",    indexed: false },
      { name: "latencyMs",    type: "uint32",  indexed: false },
      { name: "timestamp",    type: "uint64",  indexed: false },
    ]
  },
];

const client = createPublicClient({
  // Disable batching — Arc RPC rejects large batched bodies with 413.
  transport: http(ARC_RPC, { batch: false }),
  chain: { id: CHAIN_ID, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 }, rpcUrls: { default: { http: [ARC_RPC] } } },
});

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);
const fmtUsdc = (raw) => raw == null ? "—" : (Number(raw) / 1e6).toFixed(6);
const fmtMs = (ms) => {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const shortHex = (h, prefix = 8, suffix = 6) => h ? `${h.slice(0, prefix)}…${h.slice(-suffix)}` : "—";
const txLink = (h) => h ? `${SCAN}/tx/${h}` : null;

// --- State machine UI ---
const STATE_PILL = {
  idle:        { cls: "pill dim",     label: "idle" },
  registering: { cls: "pill value",   label: "registering" },
  registered:  { cls: "pill value",   label: "registered" },
  insuring:    { cls: "pill warn",    label: "insuring" },
  burning:     { cls: "pill warn",    label: "burning" },
  attesting:   { cls: "pill warn",    label: "attesting" },
  minting:     { cls: "pill warn",    label: "minting" },
  settling:    { cls: "pill value",   label: "settling" },
  settled_ok:  { cls: "pill success", label: "settled · ok" },
  settled_breach: { cls: "pill accent", label: "settled · refund" },
};

function setPosition(state) {
  const stage = state?.stage || "idle";
  const pill = STATE_PILL[stage] || STATE_PILL.idle;

  $("position-state").textContent = state?.label || "waiting for agent…";
  $("pos-status-pill").className = pill.cls;
  $("pos-status-pill").innerHTML = `<span class="dot"></span>${pill.label}`;

  $("pos-notional").innerHTML = state?.notional != null
    ? `${fmtUsdc(state.notional)}<span class="unit">USDC</span>`
    : `—<span class="unit">USDC</span>`;
  $("pos-premium").innerHTML = state?.premium != null
    ? `${fmtUsdc(state.premium)}<span class="unit">USDC</span>`
    : `—<span class="unit">USDC</span>`;

  setTxCell("tx-registry", state?.tx?.registry);
  setTxCell("tx-burn", state?.tx?.burn);
  setTxCell("tx-mint", state?.tx?.mint, "https://sepolia.basescan.org");
  setTxCell("tx-settle", state?.tx?.settle);
}

function setTxCell(id, hash, scanBase = SCAN) {
  const el = $(id);
  if (!hash) {
    el.textContent = "—";
    el.className = "hash empty";
    el.removeAttribute("href");
    return;
  }
  el.textContent = shortHex(hash);
  el.className = "hash";
  el.href = `${scanBase}/tx/${hash}`;
}

// --- Attestation timeline ---
const ATTESTATION_TARGET_MS = 15 * 60 * 1000;
let attestationStart = null;
let attestationFinishedMs = null;

function setTimeline(state) {
  const tl = $("timeline");
  const bar = $("timeline-bar");
  const elapsedEl = $("timeline-elapsed");
  const statusEl = $("timeline-status");

  if (!state?.burnStartedAt && !state?.attestationCompletedMs) {
    tl.className = "timeline";
    bar.style.width = "0%";
    elapsedEl.textContent = "00:00";
    statusEl.textContent = "pending";
    attestationStart = null;
    attestationFinishedMs = null;
    return;
  }

  if (state.attestationCompletedMs != null) {
    tl.className = "timeline done";
    bar.style.width = "100%";
    elapsedEl.textContent = fmtMs(state.attestationCompletedMs);
    statusEl.textContent = `received at T+${fmtMs(state.attestationCompletedMs)}`;
    attestationFinishedMs = state.attestationCompletedMs;
    return;
  }

  if (state.attestationTimedOut) {
    tl.className = "timeline timeout";
    bar.style.width = "100%";
    elapsedEl.textContent = "TIMEOUT";
    statusEl.textContent = "deadline exceeded";
    return;
  }

  // Live polling state — tick the elapsed every second
  attestationStart = state.burnStartedAt * 1000;
  tl.className = "timeline";
  const elapsed = Date.now() - attestationStart;
  const pct = Math.min(100, (elapsed / ATTESTATION_TARGET_MS) * 100);
  bar.style.width = `${pct}%`;
  elapsedEl.textContent = fmtMs(elapsed);
  statusEl.textContent = "attesting…";
}

setInterval(() => {
  if (!attestationStart || attestationFinishedMs != null) return;
  const elapsed = Date.now() - attestationStart;
  const pct = Math.min(100, (elapsed / ATTESTATION_TARGET_MS) * 100);
  $("timeline-bar").style.width = `${pct}%`;
  $("timeline-elapsed").textContent = fmtMs(elapsed);
}, 1000);

// --- Slippage panel ---
function setSlippage(state) {
  $("slip-threshold").textContent = state?.slaThresholdBps != null
    ? `${state.slaThresholdBps} bps`
    : "50 bps";

  const expected = state?.expectedMint;
  const actual = state?.actualMint;
  const bpsEl = $("slip-bps");
  const verdictEl = $("slip-verdict");

  $("slip-expected").innerHTML = expected != null
    ? `${fmtUsdc(expected)}<span class="unit">USDC</span>`
    : `—<span class="unit">USDC</span>`;
  $("slip-actual").innerHTML = actual != null
    ? `${fmtUsdc(actual)}<span class="unit">USDC</span>`
    : `—<span class="unit">USDC</span>`;

  if (expected == null || actual == null) {
    bpsEl.innerHTML = `—<span class="unit">bps</span>`;
    bpsEl.className = "num";
    verdictEl.className = "slip-verdict pending";
    verdictEl.textContent = "Awaiting mint settlement…";
    return;
  }

  const expectedN = Number(expected);
  const actualN = Number(actual);
  const slippageBps = expectedN > 0 ? Math.round((expectedN - actualN) * 10000 / expectedN) : 0;
  const threshold = state.slaThresholdBps ?? 50;
  const breached = slippageBps > threshold;

  bpsEl.innerHTML = `${slippageBps}<span class="unit">bps</span>`;
  bpsEl.className = breached ? "num accent" : "num success";

  if (breached) {
    verdictEl.className = "slip-verdict breach";
    verdictEl.textContent = `SLA breached. Refund triggered.`;
  } else {
    verdictEl.className = "slip-verdict ok";
    verdictEl.textContent = `Within SLA. Agent profits, premium retained.`;
  }
}

// --- Settlement receipt ---
function setReceipt(state) {
  const settled = state?.settled;
  const stateLabel = $("receipt-state");
  const payout = $("receipt-payout");

  if (!settled) {
    stateLabel.textContent = "pending";
    $("r-callId").textContent = "—";
    $("r-slug").textContent = "—";
    $("r-premium").textContent = "—";
    $("r-latency").textContent = "—";
    $("r-breach").textContent = "—";
    $("r-actualRefund").textContent = "—";
    payout.className = "receipt-payout pending";
    payout.textContent = "Awaiting settlement…";
    return;
  }

  stateLabel.textContent = "settled";
  $("r-callId").textContent = settled.callId || "—";
  $("r-slug").textContent = settled.slug || "—";
  $("r-premium").textContent = `${fmtUsdc(settled.premium)} USDC`;
  $("r-latency").textContent = settled.latencyMs != null ? `${settled.latencyMs} ms` : "—";
  $("r-breach").textContent = settled.breach ? "yes" : "no";
  $("r-actualRefund").textContent = `${fmtUsdc(settled.actualRefund)} USDC`;

  if (settled.breach) {
    payout.className = "receipt-payout breach";
    payout.textContent = `Refund paid: ${fmtUsdc(settled.actualRefund)} USDC on Arc.`;
  } else {
    payout.className = "receipt-payout ok";
    payout.textContent = `Premium retained. Pool +${fmtUsdc(settled.premium)} USDC.`;
  }
}

// --- Live state polling ---
let lastStateRaw = null;
async function pollState() {
  try {
    const res = await fetch(`${STATE_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      if (lastStateRaw !== null) { lastStateRaw = null; render(null); }
      return;
    }
    const raw = await res.text();
    if (raw === lastStateRaw) return;
    lastStateRaw = raw;
    const state = JSON.parse(raw);
    render(state);
  } catch (e) {
    // state.json missing or invalid — degrade gracefully
    if (lastStateRaw !== null) { lastStateRaw = null; render(null); }
  }
}

function render(state) {
  setPosition(state);
  setTimeline(state);
  setSlippage(state);
  setReceipt(state);
}

// --- On-chain event feed ---
async function pollChainEvents() {
  try {
    const head = await client.getBlockNumber();
    // Arc RPC caps eth_getLogs at 10k blocks. ~510ms/block ≈ 17min window with 2000.
    // Kept small to avoid 413 if batch ever re-enables.
    const from = head > 2000n ? head - 2000n : 0n;
    const logs = await client.getLogs({
      address: SETTLER,
      event: SETTLER_EVENT_ABI[0],
      fromBlock: from,
      toBlock: head,
    });

    const decoded = logs.slice(-5).reverse().map((log) => {
      const ev = decodeEventLog({ abi: SETTLER_EVENT_ABI, data: log.data, topics: log.topics });
      return {
        block: log.blockNumber,
        txHash: log.transactionHash,
        callId: ev.args.callId,
        agent: ev.args.agent,
        premium: ev.args.premium,
        actualRefund: ev.args.actualRefund,
        breach: ev.args.breach,
        latencyMs: ev.args.latencyMs,
      };
    });

    renderFeed(decoded, head);
  } catch (e) {
    $("feed-status").textContent = `rpc error · ${e.message?.slice(0, 40) || "unknown"}`;
  }
}

function renderFeed(events, head) {
  const tbody = $("event-feed");
  $("feed-status").textContent = `block ${head} · ${events.length} recent`;

  if (events.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center; padding: 24px;">no settlements on this contract yet</td></tr>`;
    return;
  }

  tbody.innerHTML = events.map((e) => `
    <tr>
      <td>${e.block}</td>
      <td>${e.breach ? '<span class="pill accent">breach</span>' : '<span class="pill success">ok</span>'}</td>
      <td>${e.latencyMs} ms</td>
      <td>${fmtUsdc(e.premium)}</td>
      <td>${fmtUsdc(e.actualRefund)}</td>
      <td>${shortHex(e.callId)}</td>
      <td><a target="_blank" rel="noopener" href="${SCAN}/tx/${e.txHash}">${shortHex(e.txHash)}</a></td>
    </tr>
  `).join("");
}

// --- Init ---
function initLinks() {
  $("link-registry").href = `${SCAN}/address/${REGISTRY}`;
  $("link-pool").href     = `${SCAN}/address/${POOL}`;
  $("link-settler").href  = `${SCAN}/address/${SETTLER}`;
  $("link-github").href   = GITHUB;
  $("rpc-url").href       = ARC_RPC;
}

initLinks();
render(null);
pollChainEvents();
setInterval(pollState, STATE_POLL_MS);
setInterval(pollChainEvents, CHAIN_POLL_MS);
pollState();
