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

## Receipts (canonical happy-path run, 2026-05-25)

- burn (Arc):  https://testnet.arcscan.app/tx/0x19f62f49ad2011c809cca2ff037937013995bb5d3b9cb404d7a845915f528fd8
- mint (Base Sepolia):  https://sepolia.basescan.org/tx/0x6ad3e4483fd31aebb74d8969b77b12633a181827fdaec090f26083a3331e8d14
- settle PASS (Arc):  https://testnet.arcscan.app/tx/0xf434771d1a63869cac20db53f3973eaac4f56272f84e853ecad4eece6c4b6798

Repo: https://github.com/pactnetwork/pact-arc-arbitrage · License: Apache-2.0

Contact: rick@quantum3labs.com · Telegram [t.me/metalboyrick](https://t.me/metalboyrick)
