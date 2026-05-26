# Pact × Agora — Loom Recording Guide

Everything you need to record the submission video in one file. Keep this open on a second monitor while recording — glance, don't read.

Target length: **~3 minutes**. Hard cap: 5 minutes.

---

## Part 1 — Pre-recording setup

### 1.1 Environment

```bash
cd ~/rick_quantum3labs_com/dev/pact-network/pact-agora

# Confirm .env exists with the funded wallet keys
test -f .env && echo "OK: .env exists" || echo "MISSING — copy from pact-arc-demo"

# If missing:
cp ../pact-arc-demo/.env .env
```

### 1.2 Sanity check — preflight passes

```bash
pnpm preflight
```

Expect: `✓ AUTHORITY key matches registry.authority()` and `✓ all three wallets have sufficient USDC for the demo`. If anything fails, stop and fix before recording.

### 1.3 Funding check — wallet balances

- **Arc Testnet USDC**: need ≥ 3 USDC at `0x95B33bDf...28E6`. Top up at https://faucet.circle.com if low.
- **Base Sepolia ETH**: need ≥ 0.0001 ETH at same address for `receiveMessage` gas.

Verify quickly:
```bash
node -e "const {createPublicClient,http,formatEther,formatUnits}=require('viem');const a='0x95B33bDf8eb1b37f1acC4F80451E37469A1E28E6';const base=createPublicClient({transport:http('https://sepolia.base.org')});base.getBalance({address:a}).then(b=>console.log('Base ETH:',formatEther(b)));"
```

### 1.4 Open these tabs in your browser

| Tab | URL |
|---|---|
| Dashboard | http://localhost:8910 |
| Arcscan — Pool | https://testnet.arcscan.app/address/0xc5d4c573828e998695b6bd5577947bc77a8f7f97 |
| Arcscan — Settler | https://testnet.arcscan.app/address/0xccf30140d74cc0d384800501506d50fe622ae963 |
| BaseScan — USDC | https://sepolia.basescan.org/address/0x036cbd53842c5426634e7929541ec2318f3dcf7e |
| GitHub repo | https://github.com/pactnetwork/pact-arc-arbitrage |

### 1.5 Start the dashboard server

```bash
# In a second terminal — leave it running for the whole recording
pnpm dashboard
```

Reload http://localhost:8910 — should show the dashboard UI even before the agent has run.

### 1.6 Terminal cosmetics

- Bump font size to **18-20pt** so step headers are legible on Loom playback.
- Clear scrollback before each take: `clear`.
- Make sure the terminal is wide enough that the `STEP N — ...` separators don't wrap.

### 1.7 Loom recording settings

- **Camera + screen** (your face in the corner — keeps it personal).
- **Mic check** with one practice take.
- **Cursor highlight ON** so judges can follow what you click.

---

## Part 2 — The script

Spoken cues in bold. Don't read them word-for-word — these are anchor phrases, talk around them.

### [0:00–0:15] Hook

**[Switch to terminal, fresh `clear`d screen]**

> "An agent moves USDC across chains. The bridge takes minutes. During that wait the price can move, the attestation can stall, the mint can short-deliver. Today the agent just eats that risk. I built a protocol that prices it."

### [0:15–0:35] Thesis

> "I'm Rick, building Pact Network. We insure the window between when an agent commits funds and when the bridge actually settles. Today's demo: an arb agent burns USDC on Arc, waits for Circle CCTP to attest, mints on Base Sepolia. That wait is the product. If the bridge breaches the SLA — too slow, or destination drift — Pact refunds the agent on Arc in the same USDC, same chain, no second bridge."

### [0:35–0:50] Preflight — prove it's real testnet

**Run:**
```bash
pnpm preflight
```

**Talk over it:**

> "First, preflight. This isn't a mock — we're hitting the real Pact contracts on Arc Testnet right now. There's the chain ID 5042002. Pool, Registry, Settler addresses live on Arcscan. Wallet's funded. Green light."

### [0:50–2:00] Happy path — run the agent

**Run:**
```bash
pnpm agent
```

**Talk through each step as it lands. The whole thing finishes in ~30s, so you'll narrate over the top:**

> "Step 1 — registers the slug on Pact. Step 2 — sees a 40 bps gap between Arc and Base USDC. Step 3 — buys insurance. There's the callId. Step 4 — burns 1 USDC on Arc, real tx on Arcscan. Step 5 — polls Circle's Iris API for attestation. On mainnet that's a fifteen-minute window for Arc-outbound. On testnet sandbox it's about sixteen seconds. Step 6 — mints on Base Sepolia, agent gets 1 USDC there. Step 7 — settler checks: zero bps slippage, sixteen seconds, well under our SLA, no breach. Step 8 — settles on Arc, pool keeps the 0.05 USDC premium. Three real transactions, thirty seconds end-to-end."

### [2:00–2:15] Click into Arcscan — credibility

**Switch to the Arcscan tab. Click the settle tx URL from the terminal output.**

> "Here's the settle on Arcscan. CallSettled event, premium 0.05, latency around sixteen thousand milliseconds, breach false. Real on-chain receipt. Every link in the repo points to one of these."

### [2:15–2:40] Breach path — what happens when bridges fail

**Switch back to terminal. Clear screen. Run:**

```bash
IRIS_POLL_TIMEOUT_S=5 pnpm agent
```

**Talk over it:**

> "Now the part that matters — what happens when bridges fail. I'm setting the Iris timeout to five seconds, so the attestation will time out and trigger the breach path. Burn happens, attestation times out, settler submits BridgeTimeout, pool refunds principal plus premium back to the agent on Arc. There's the refund tx — 1.05 USDC back to the agent's wallet. That's what insurance looks like."

### [2:40–3:00] Close

**Switch to the GitHub tab.**

> "Pact contracts are already deployed and verified on Arc. This agent is about 930 lines of TypeScript. Everything's on GitHub at pactnetwork slash pact-arc-arbitrage. Apache 2.0. If you're building agents that move real money, talk to me — rick at quantum3labs.com, Telegram metalboyrick. Thanks."

---

## Part 3 — Fallback plans

### If `pnpm agent` hangs at STEP 5

Iris sandbox is degraded. Two options:

1. **Cut and restart with a shorter timeout** for narration room:
   ```bash
   IRIS_POLL_TIMEOUT_S=30 pnpm agent
   ```
2. **Reframe and lead with the breach take**: skip happy path, open with `IRIS_POLL_TIMEOUT_S=5 pnpm agent` and pitch it as "showing the insurance triggering." The product story still works.

### If a tx reverts on chain

Most likely cause: another instance of the demo is running concurrently, or someone replayed the message. Wait 30 seconds, re-run.

### If preflight fails on AUTHORITY mismatch

The wallet that owns the deployed protocol differs from what's in `.env`. Either:
- Switch to the correct key in `.env`, or
- Use `AUTHORITY_PRIVATE_KEY` of the wallet that owns Pact Registry on Arc Testnet.

### If the dashboard doesn't update

The dashboard polls `examples/agora-arc-arbitrage/state.json`. If the agent isn't writing it, confirm you're running `pnpm agent` from the repo root (not from inside `examples/`).

---

## Part 4 — After recording

1. **Upload Loom** — set to "anyone with the link," capture the URL.
2. **Update the README receipts block** if you ran new transactions (or skip — the canonical 2026-05-25 receipts already in the README are real).
3. **Submit to Agora hackathon** — repo URL + Loom URL + one-paragraph pitch (see `DEPLOYMENT.md` §11).
4. **Share on X / Telegram** for visibility — anchor tweet should include the Loom + repo + one tx link.

---

## Part 5 — Reference receipts (canonical 2026-05-25 happy path)

These are real, on-chain, click-to-verify:

| Step | Tx |
|---|---|
| burn (Arc) | https://testnet.arcscan.app/tx/0x19f62f49ad2011c809cca2ff037937013995bb5d3b9cb404d7a845915f528fd8 |
| mint (Base Sepolia) | https://sepolia.basescan.org/tx/0x6ad3e4483fd31aebb74d8969b77b12633a181827fdaec090f26083a3331e8d14 |
| settle PASS (Arc) | https://testnet.arcscan.app/tx/0xf434771d1a63869cac20db53f3973eaac4f56272f84e853ecad4eece6c4b6798 |

- callId: `0x713c87a5414fb679c45ad9504e13cc5f`
- Iris attestation: 16.2s
- Slippage: 0 bps · Latency: 16170 ms · Breach: false
- Premium 0.050 USDC kept by pool · Refund 0 USDC
- Total runtime: ~30s

---

## Part 6 — One-paragraph pitch (for submission form)

> Pact insures the window between when an agent commits funds and when a cross-chain bridge actually settles. An arb agent burns USDC on Arc, waits ~15 minutes for Circle CCTP attestation, then mints on Base Sepolia — that wait is where the price moves, the attestation stalls, and the mint short-delivers. Pact prices that risk: premium locked on Arc when the burn submits, refund on Arc if the bridge breaches the latency or slippage SLA. Demo runs end-to-end against the Pact contracts deployed on Arc Testnet — three real transactions, thirty seconds. github.com/pactnetwork/pact-arc-arbitrage.

---

## Delivery notes (read once before recording)

- **Don't read the script.** Glance at the anchor phrases, then talk. AI-sounding narration kills agent-product credibility faster than anything.
- **The 30-second runtime is your hook.** Most insurance demos hand-wave the on-chain part. Yours fits inside a Loom.
- **Skip the debugging anecdotes** (the mint-detection bug, the contract address reconcile). They're not product story.
- **One run per take.** Don't try to fix mid-record — cut, re-prep, re-record.
- **Smile on the close.** People remember the energy of the last 5 seconds more than the middle.
