# Agora-Arc arb agent

An off-chain arb agent that detects a USDC price gap between Arc Testnet and Base Sepolia, insures the bridged leg with Pact Network, runs the full Circle CCTP v2 burn → Iris attestation → destination mint flow, and settles the insurance contract based on what actually happened.

Arc settles in **510 ms**. CCTP attestation takes **~15 minutes**. That window is the product. While the agent waits for Circle's attestation, the arb opportunity can close, the destination price can move, and the agent can mint less USDC than it expected. Pact insures that window — premium is locked on Arc when the burn is submitted, and if either the latency SLA or the slippage tolerance is breached, the contract refunds the agent's principal + premium in USDC on Arc.

The demo runs end-to-end against live testnets. Every transaction in the output is a real on-chain tx — Arc Pact contracts, Arc CCTP burn, Base Sepolia mint, Arc Pact settle. Judges can click each Arcscan / BaseScan link and verify the receipts.

This example is built **on top of** the protocol demo (`../../src/demo.ts`). The Pact contracts, ABIs, slug-encoding helpers, and Arc chain definition are reused unchanged.

## Prerequisites

- Node ≥ 20
- ~3 USDC on Arc Testnet at the AUTHORITY wallet (pool top-up, gas)
- ~1.2 USDC on Arc Testnet at the AGENT wallet (1 USDC principal + 0.05 premium + buffer)
- ~0.0001 ETH on Base Sepolia at the AGENT wallet (gas for `receiveMessage`)
- Faucets:
  - USDC on Arc + Base: https://faucet.circle.com (20 USDC / address / 2h, reCAPTCHA)
  - ETH on Base Sepolia: any public faucet (Alchemy, QuickNode)

## How to run

```bash
cd pact-arc-demo
cp examples/agora-arc-arbitrage/.env.example .env
# fill AUTHORITY_PRIVATE_KEY / SETTLER_PRIVATE_KEY / AGENT_PRIVATE_KEY in .env
pnpm install
pnpm tsx examples/agora-arc-arbitrage/agent.ts
```

The run takes ~15 minutes wall-clock (dominated by CCTP standard-threshold attestation latency). The agent logs every 12 polls (~60 s) while waiting on Iris so you know it's alive.

## Expected output

```
Pact Network — Agora-Arc arb agent
Arc:  chain 5042002 via https://rpc.testnet.arc.network
Base: chain 84532 via https://sepolia.base.org
Agent (Arc):  0x6e3013db053a51EEd969Fe884547c9184218916e
Agent (Base): 0x6e3013db053a51EEd969Fe884547c9184218916e

──────────────────── STEP 1 — Setup Pact endpoint "arc-base-cctp-usdc" ────────────────────
  ✓ slug bytes16 = 0x6172632d626173652d637...
  ✓ settler role granted (or already present)
  ✓ pool funded

──────────────────── STEP 2 — Check Arc <-> Base Sepolia USDC price gap ────────────────────
  · Arc:  0.998000 USDC/USD
  · Base: 1.002000 USDC/USD
  · Gap:  40 bps

──────────────────── STEP 3 — Buy Pact insurance ────────────────────
  ✓ callId = 0x...
[T+1.2s] insured

──────────────────── STEP 4 — CCTP burn on Arc ────────────────────
  ✓ burn tx: https://testnet.arcscan.app/tx/0x...
[T+2.4s] burn submitted

──────────────────── STEP 5 — Poll Iris for attestation ────────────────────
  · ...still polling (poll #12, 60s elapsed)
  · ...still polling (poll #24, 120s elapsed)
  · ...
  ✓ attestation received after 887.4s (nonce=12345)

──────────────────── STEP 6 — Mint on Base Sepolia ────────────────────
  ✓ mint tx: https://sepolia.basescan.org/tx/0x...
  · actually minted: 1.000000 USDC (expected 1.000000 USDC)

──────────────────── STEP 7 — Compute slippage + SLA decision ────────────────────
  · slippage: 0bps (threshold 50bps)
  · latency:  887412ms (threshold 900000ms)
  · breach:   false  (latencyBreach=false, slippageBreach=false)

──────────────────── STEP 8 — Settle call on PactSettler ────────────────────
  ✓ settle tx: https://testnet.arcscan.app/tx/0x...
  · decoded: premium=0.050000 USDC refund=0.000000 USDC actualRefund=0.000000 USDC status=...

──────────────────── STEP 9 — Final state ────────────────────
  · pool.currentBalance = 2.050000 USDC   (← grew by the premium)
  · pool.totalPremiums  = 0.050000 USDC
  · pool.totalRefunds   = 0.000000 USDC

DONE. Tx evidence:
  burn   https://testnet.arcscan.app/tx/0x...
  mint   https://sepolia.basescan.org/tx/0x...
  settle https://testnet.arcscan.app/tx/0x...

Narrative: Arc settles in 510ms. CCTP attestation took 887s.
That window is the product.
```

If attestation latency exceeds `IRIS_POLL_TIMEOUT_S` (default 30 min), the agent triggers the **BridgeTimeout** settle path — full principal + premium refund on Arc — instead of crashing. That's the breach demo path.

## Files

```
agent.ts          end-to-end entrypoint (read top-to-bottom)
config.ts         env loading, chain defs, contract addresses
pact.ts           wrappers around the deployed PactRegistry/Pool/Settler
cctp.ts           viem wrappers for TokenMessengerV2 + MessageTransmitterV2
iris.ts           Iris attestation polling loop
prices.ts         USDC price-gap source (mock or CoinGecko)
.env.example      env template
```

## Submission narrative

> Arc settles in 510 ms. CCTP attestation takes ~15 minutes. That window is the product. Pact insures the bridge window — premium on Arc, refund on Arc, all in USDC. The agent code in this directory is what a real arb agent would drive end-to-end without having to write its own bridge-failure-handling logic.

## Honest scope

- The agent EOA is a freshly funded throwaway, not a deployed agent runtime.
- "Purchase insurance" is a logical step today — premium is pulled at settle time, not at purchase time, because the deployed `PactSettler.settleBatch` is single-call. The two-step on-chain reservation lands with the facilitator milestone (Circle grant Milestone 1).
- Price gap source defaults to deterministic mock so judges always see the same hero number. Set `PRICE_SOURCE=coingecko` for the live (still synthetic) gap.
- Arc → Base Sepolia uses **standard** CCTP (~15 min), not Fast Transfer — Arc Testnet does not support Fast outbound today.
