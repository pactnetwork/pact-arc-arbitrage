# Agora Submission — copy-paste ready

Use these verbatim in the Agora submission form. Each block answers one form field.

---

## Problem Statement

> What problem is your project solving? What is compelling about this problem?

An agent moving USDC across chains doesn't know for ~15 minutes whether the bridge will deliver. The destination price can drift, the attestation can stall, the mint can short-deliver. Today the agent eats that risk — there's no protocol that prices the bridge window, and no on-chain recourse when the bridge breaches its SLA. As agents start moving real money instead of $0.001 search queries, that asymmetry stops being acceptable.

What's compelling: the gap is concrete (~15 minutes per Circle CCTP standard transfer on Arc-outbound), it's measurable on-chain (latency plus destination amount), and it recurs on every cross-chain agent payment. It's the kind of problem where insurance actually works — because the breach is observable.

---

## Project Description

> Describe what your project does, how it works, and what tech you used.

An off-chain arbitrage agent burns USDC on Arc Testnet via Circle CCTP v2, waits for Iris attestation, mints on Base Sepolia, and settles a Pact Network insurance contract based on what actually happened.

Flow: agent registers a slug on Pact Registry, locks a 0.05 USDC premium against a 1 USDC principal, calls `TokenMessengerV2.depositForBurn` on Arc, polls Circle Iris for attestation, calls `MessageTransmitterV2.receiveMessage` on Base Sepolia, then submits `PactSettler.settleBatch` on Arc with `breach = latencyMs > 900_000 OR slippageBps > 50`. On breach, the pool refunds principal + premium on Arc. On pass, the pool keeps the premium.

Tech: TypeScript agent (~930 LoC) on viem; inline CCTP v2 ABI fragments; Pact protocol contracts already deployed and Arcscan-verified on Arc Testnet (no new Solidity for the hackathon); static HTML + ES module dashboard. End-to-end run: three real on-chain transactions in ~30 seconds.

---

## Arc OSS — Why pick this project / what primitives we expose

> (Arc OSS) If you are applying for Arc OSS, why should we choose your project? What primitives are you exposing that other builders could find useful? Compared to the code out there for Arc builders (mostly in circlefin/arc-* repos) what tools and flows do you add?

We built `pact-arc-arbitrage` to show Arc builders the one thing the `circlefin/arc-*` repos don't: how to put an insurance layer on top of CCTP v2 so agents can actually deploy capital cross-chain without eating tail risk.

It's ~930 lines of TypeScript on viem, runs end-to-end in about 30 seconds, and produces three real on-chain receipts on Arc Testnet → Base Sepolia. Apache-2.0, public, no fluff.

The Pact protocol contracts are already deployed and Arcscan-verified on Arc Testnet (Phase-07b, 2026-05-19) — any Arc builder can call them today, no redeploy, no audit dependency:

- PactRegistry `0x60e51f2c8c162ec13c7c7234fc9490936127f01b`
- PactPool `0xc5d4c573828e998695b6bd5577947bc77a8f7f97`
- PactSettler `0xccf30140d74cc0d384800501506d50fe622ae963`

**Primitives we expose to other builders** (full ABIs in `src/abi/`):

- `registerEndpoint(bytes16 slug, uint64 flatPremium, uint16 percentBps, uint32 slaLatencyMs, uint64 imputedCost, uint64 exposureCapPerHour, …)` — declare any agent flow as insurable with its own SLA, pricing curve, and hourly exposure cap. One call wires a builder's product into the protocol.
- `updateEndpointConfig(...)` — retune SLA and premium math without redeploying. Pricing is a parameter, not a fork.
- `topUp(bytes16 slug, uint64 amount)` — anyone (agent operator, LP, sponsor) can fund a specific endpoint's coverage pool in USDC. Underwriting is permissionless per-slug.
- `settleBatch(SettlementEvent[] events)` — decouples off-chain breach detection from on-chain settlement. One settler tx atomically charges premiums, pays refunds, splits fees across endpoints.
- `recordCallAndCapAccrual(slug, premium, breach, intendedRefund) → payableRefund` — exposure-cap math is exposed as a primitive; builders compose their own settlers and get back the hourly-capped refund.
- `balanceOf(bytes16 slug) → PoolState` — read `currentBalance / totalPremiums / totalRefunds` per endpoint. Dashboards, vaults, and risk routers consume coverage state directly.
- `CallSettled(callId, slug, agent, premium, refund, actualRefund, status, breach, latencyMs, timestamp)` — single canonical event. Indexers and downstream agents subscribe without reading storage.

**What we add vs the `circlefin/arc-*` repos:** those show CCTP on Arc, USDC-as-gas, basic chain integration. We add the insurance layer on top — the missing piece that lets agents actually take risk on Arc. A copy-pasteable viem template for `register slug → top up → insure → execute → settle` that works for any cross-chain agent flow (not just CCTP), plus a `settleBatch` pattern that lets settlers combine arbitrary off-chain dimensions (latency, slippage, HTTP status, schema diff) without modifying Solidity.

Pick us if you want a reference repo that pushes Arc beyond "CCTP works here" into "agents can take real risk here." A builder reading `agent.ts` ships insurance into their own Arc flow the same afternoon.

---

## Circle / Arc Feedback

> What worked with Circle / Arc, and where can Circle / Arc improve as a product and resources?

**What worked:**

- Arc Testnet RPC at `https://rpc.testnet.arc.network` was rock solid for the whole build — no signup, no rate-limit pain, fast block times.
- USDC-as-native-gas is genuinely a feature for agent code. Funded one wallet at `faucet.circle.com` (20 USDC per address per 2h, delivered in seconds) and that single funding step covered preflight, contract calls, AND gas. No second token to chase.
- CCTP v2 contract addresses on Arc matched the deployed `0x8FE6...DAA` / `0xE737...275` exactly as documented, and the `depositForBurn(amount, destDomain, mintRecipient, burnToken, destCaller, maxFee, minFinalityThreshold)` signature matched Circle's V2 quickstart docs without surprises.
- Iris sandbox at `iris-api-sandbox.circle.com/v2/messages/26` returned Arc → Base Sepolia attestations in **~16 seconds wall-clock**. Excellent for hackathon iteration speed.
- Arcscan is fast, contract source is verifiable, links are stable.

**Where Circle / Arc can improve:**

- **Docs vs sandbox disagree on CCTP timing.** Public docs say Arc-outbound is the "standard ~15 min" CCTP window. The sandbox returns in 15-20s. We had to discover the actual testnet behavior by running it. Either ship a "testnet timing" footnote, or set sandbox latency to match what mainnet will feel like so builders calibrate UX correctly.
- **Base Sepolia public RPC read-lag is a real gotcha.** `balanceOf` immediately after a successful `receiveMessage` mint returned `0` for several seconds — we burned a USDC top-up triggering a false breach on our first run before switching detection to read the `Transfer` event from the receipt. Doc this as a known footgun in the CCTP v2 quickstart with a recommended pattern.
- **No discoverable registry of protocols already deployed on Arc.** We had two competing sets of Pact contract addresses in our own repo (old draft vs current deploy); a `circlefin/arc-ecosystem` index or even a `protocols.json` in `circlefin/arc-*` would have caught this in 30 seconds.
- **Arcscan could surface a "Circle-grant deploy" badge** for contracts deployed under Circle grant programs. Right now there's no on-platform way to tell whether a verified contract is the canonical one for a given protocol or a fork. Trust signals matter for agent operators choosing what to integrate.
- **CCTP v2 ABI is published as docs prose, not as a JSON artifact under `circlefin/cctp-evm-contracts` releases.** We had to hand-transcribe the function signature. A versioned ABI bundle per minor release would prevent fork drift.

---

## General Feedback for Canteen

> What worked well? What didn't? What could the Canteen team improve for future hackathons?

I'll be honest: I built the project, didn't engage the Canteen platform deeply enough to have strong specific feedback. The submission flow was clear, the timeline was respected, and the prompt was specific enough to focus the build (Agora agents + Arc OSS angles together).

One thing that would help future builds: a **public scoring rubric** ahead of the deadline. Builders calibrate scope to what's actually measured. Right now I'm guessing at the weight of "code quality" vs "demo polish" vs "originality" vs "ecosystem fit." Even a one-line per-axis hint ("we weight a working end-to-end run over scope ambition") would shape submissions toward what you actually want to reward.

Also: a public list of past winners with their submission artifacts would help calibrate ambition. Hackathons that publish "here's what won last cycle" produce better submissions next cycle.

---

## Receipts (canonical happy-path run, 2026-05-25)

- burn (Arc):  https://testnet.arcscan.app/tx/0x19f62f49ad2011c809cca2ff037937013995bb5d3b9cb404d7a845915f528fd8
- mint (Base Sepolia):  https://sepolia.basescan.org/tx/0x6ad3e4483fd31aebb74d8969b77b12633a181827fdaec090f26083a3331e8d14
- settle PASS (Arc):  https://testnet.arcscan.app/tx/0xf434771d1a63869cac20db53f3973eaac4f56272f84e853ecad4eece6c4b6798

Repo: https://github.com/pactnetwork/pact-arc-arbitrage · License: Apache-2.0

Contact: rick@quantum3labs.com · Telegram [t.me/metalboyrick](https://t.me/metalboyrick)
