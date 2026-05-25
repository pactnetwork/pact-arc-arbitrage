# Deployment & Recording Walkthrough

End-to-end setup, run, and "ready to record" steps for the Pact × Agora submission. Total cold-start to first happy-path run: ~5 minutes.

---

## 1. Prerequisites

| Requirement | Why | How |
|---|---|---|
| Node `>= 20` | `tsx` + `viem` runtime | `node --version` |
| Python 3 | static dashboard server (`python3 -m http.server`) | `python3 --version` |
| `pnpm` (or `npm`) | dependency install | `npm i -g pnpm` |
| One EVM wallet | acts as AUTHORITY, SETTLER, AGENT (or 3 separate keys for a production-shaped run) | any wallet — export 32-byte hex private key |
| ~3 USDC on Arc Testnet | pool top-up + premium + gas (Arc uses USDC as native gas) | https://faucet.circle.com (select Arc Testnet) |
| ~0.001 ETH on Base Sepolia | `receiveMessage` gas | any Base Sepolia faucet (Alchemy / QuickNode) |

The Pact contracts and USDC on both sides are already deployed and verified. Nothing in this repo deploys new Solidity.

---

## 2. Clone & install

```bash
git clone <repo-url> pact-agora
cd pact-agora
pnpm install
```

If you don't want pnpm, `npm install` works — the `pnpm-lock.yaml` is shipped for reproducibility but a fresh `npm install` against `package.json` will resolve identically against the pinned `viem`, `dotenv`, `tsx`, `typescript`.

---

## 3. Environment setup

```bash
cp .env.example .env
```

Fill in the three private keys. **Minimal config** (one wallet acting as all three roles, default for this hackathon):

```
AUTHORITY_PRIVATE_KEY=0x<your_funded_wallet_private_key>
SETTLER_PRIVATE_KEY=0x<same_value>
AGENT_PRIVATE_KEY=0x<same_value>
```

**Production-shaped split** (recommended for a real deploy, not required for the hackathon):

```
AUTHORITY_PRIVATE_KEY=0x<wallet_A>    # registers slug, grants roles
SETTLER_PRIVATE_KEY=0x<wallet_B>       # submits settleBatch
AGENT_PRIVATE_KEY=0x<wallet_C>         # burns USDC, receives mint, pays premium
```

Everything else in `.env.example` (RPC URLs, Pact contract addresses, CCTP contract addresses, demo parameters) is pre-filled with the correct values. **Do not change them** unless you're redeploying against a different chain.

---

## 4. Preflight — verify everything works before spending USDC

```bash
pnpm preflight
```

Expected output:

```
Pact Network — Arc Testnet protocol demo
Chain id: 5042002  RPC: https://rpc.testnet.arc.network
Registry: ...
Pool:     ...
Settler:  ...

STEP 0 — Pre-flight
  · chain id 5042002 block <N> ts <T>
  ✓ USDC decimals == 6
  ✓ protocol not paused
  ✓ AUTHORITY key matches registry.authority()
  · AUTHORITY USDC: <N> USDC
  · SETTLER   USDC: <N> USDC
  · AGENT     USDC: <N> USDC
  ✓ all three wallets have sufficient USDC for the demo

Pre-flight only — exiting before any state change.
```

If any line shows ✗ or an error, fix the underlying issue before running the agent. Common failures:
- **Missing USDC** → top up at https://faucet.circle.com
- **`AUTHORITY key matches registry.authority()` fails** → the AUTHORITY private key doesn't match the wallet that owns the deployed protocol. Either change the AUTHORITY env to the correct key, or grant your wallet the AUTHORITY role first. For the hackathon, the protocol's owner key is the one that should match.

---

## 5. Start the dashboard (optional — for the recording)

In a separate terminal:

```bash
pnpm dashboard
# open http://localhost:8910
```

The dashboard polls `examples/agora-arc-arbitrage/state.json` every 2s as the agent updates it. You'll see the position transition through `idle → registering → insuring → burning → attesting → minting → settling → settled_ok` (or `settled_breach`).

---

## 6. Run the agent — happy path

```bash
pnpm agent
```

Expected runtime: **~30 seconds** on testnet (the sandbox Iris attestation returns much faster than the mainnet ~15-min Arc-outbound standard window).

Expected output ends with:

```
DONE. Tx evidence:
  burn   https://testnet.arcscan.app/tx/0x...
  mint   https://sepolia.basescan.org/tx/0x...
  settle https://testnet.arcscan.app/tx/0x...

Narrative: Arc settles in 510ms. CCTP attestation took ~16s.
That window is the product.
```

Every link is a real on-chain receipt. Click through to verify on Arcscan / BaseScan.

USDC cost per happy-path run: **0.05 USDC** (premium kept by pool) + gas. Burn principal returns to the pool's destination accounting.

---

## 7. Run the agent — breach path (for the recording's "what happens when bridges fail" beat)

To force a real `BridgeTimeout` settle path without waiting for an actual Iris outage:

```bash
IRIS_POLL_TIMEOUT_S=5 pnpm agent
```

The agent will burn USDC, wait 5 seconds for attestation, fail with `IrisDeadlineExceeded`, and submit a full-refund settle on Arc. Principal + premium come back to the agent.

USDC cost per breach-path run: **~0** (principal + premium are refunded; only Arc gas is spent).

---

## 8. Recording checklist

Before hitting record:

- [ ] Wallets funded (`pnpm preflight` passes)
- [ ] `.env` has `PRICE_SOURCE=mock` (deterministic hero number across takes)
- [ ] Dashboard tab open at `http://localhost:8910`
- [ ] Terminal font scaled up — the step headers (`STEP N`) are the visual anchors
- [ ] Arcscan + BaseScan open in separate tabs to verify-on-camera at the end

Suggested take structure (~3 min):

1. Run preflight on camera — establishes "we're against real testnets."
2. Run `pnpm agent` for the happy path. Talk through each STEP as it lands. The whole thing finishes in ~30s.
3. Show one tx on Arcscan to prove it's real.
4. Cut, then run `IRIS_POLL_TIMEOUT_S=5 pnpm agent` to show the breach payout. Show the refund tx on Arcscan.
5. Closing line: "Arc settles in 510ms. CCTP attestation takes minutes. That window is the product."

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required env: PACT_REGISTRY` | `.env` not loaded | run from repo root; confirm `.env` exists |
| Preflight: `AUTHORITY_PRIVATE_KEY mismatch` | wrong owner key | use the wallet that owns the deployed protocol, or grant your wallet AUTHORITY role |
| `receiveMessage reverted` on Base Sepolia | message replay, wrong attestation, or gas issue | re-run with fresh callId; check AGENT has ≥0.0001 ETH on Base Sepolia |
| Step 5 hangs on Iris polling | sandbox degraded | set `IRIS_POLL_TIMEOUT_S=60` to force the breach path |
| Pool top-up step burns USDC unnecessarily | pool already funded | step is idempotent — it only tops up if `currentBalance < topUpAmount` |
| Dashboard shows stale state | `state.json` not being written | confirm agent is running in this repo's root; dashboard reads `examples/agora-arc-arbitrage/state.json` |
| `actually minted: 0.000000 USDC` even though mint tx succeeded | balanceOf delta hit RPC read-lag (fixed in this repo — extracts Transfer event from receipt instead) | if you see this, pull latest |

---

## 10. Pushing to a fresh GitHub remote

If you want this repo on a separate GitHub origin (e.g., `github.com/pactnetwork/pact-arc-arbitrage` for hackathon submission):

```bash
cd pact-agora
git init
git add .
git commit -m "Initial commit — Pact × Agora hackathon submission"

# create the remote repo (gh CLI) — public for submission
gh repo create pactnetwork/pact-arc-arbitrage --public --source=. --remote=origin --push
```

Or manually:

```bash
gh repo create pactnetwork/pact-arc-arbitrage --public --confirm
git remote add origin git@github.com:pactnetwork/pact-arc-arbitrage.git
git branch -M main
git push -u origin main
```

The `.gitignore` excludes `.env`, `node_modules`, `state.json`, and logs — review with `git status` before pushing to confirm nothing sensitive is staged.

---

## 11. Submitting to the Agora hackathon

Per the Agora Agents Hackathon (May 11–25, 2026) rules:

1. Repo URL: `https://github.com/pactnetwork/pact-arc-arbitrage`
2. Demo video: record per section 8 above, post to YouTube/X, link from README
3. Submission form: link the repo + video + a one-paragraph pitch ("x402 has zero buyer protection. Pact insures cross-chain agent payments…")
4. Live contracts list: pull from README "Live contracts on Arc Testnet" table — each is Arcscan-verified

Done.
