# Pact × Agora — Insurance for Cross-Chain Agent Markets on Arc

> Agora Agents Hackathon submission. Built on Pact Network's production contracts on Arc Testnet. The agent burns USDC on Arc, mints on Base Sepolia via Circle CCTP v2, and settles a Pact insurance call based on what actually happened on the bridge.

## TL;DR

x402 has zero buyer protection. Pact is the protocol that fixes it for institutions handling agent money. This demo wires an off-chain arbitrage agent to Pact's already-deployed contracts on Arc Testnet and insures every Circle CCTP v2 bridge leg the agent runs. On breach (attestation latency or destination slippage), the agent gets a USDC refund on Arc; on success, the pool keeps the premium. No new Solidity was deployed for this hackathon.

## What ships in this repo

```
pact-agora/
├── examples/agora-arc-arbitrage/    the off-chain agent (entry: agent.ts)
├── src/                             shared Pact protocol wrappers + ABIs (reused from Pact Network)
├── dashboard/                       static HTML dashboard that polls the agent's state.json
├── demo.sh                          one-shot preflight + run
└── DEPLOYMENT.md                    step-by-step setup, deployment, recording walkthrough
```

The agent itself is ~930 LoC across 7 TypeScript files. Read `examples/agora-arc-arbitrage/agent.ts` top-to-bottom — every numbered STEP maps to a hero log line.

## The demo flow

1. **Setup** — agent registers slug `arc-cctp-base` on Pact Registry (idempotent), grants Settler role, tops up the pool.
2. **Price gap** — agent observes a USDC/USD gap between Arc and Base Sepolia (mock by default; CoinGecko via `PRICE_SOURCE=coingecko`).
3. **Insure** — agent issues a logical `callId` and approves the Settler to pull premium.
4. **Burn** — agent calls `TokenMessengerV2.depositForBurn` on Arc.
5. **Attest** — agent polls Circle's Iris sandbox for attestation. (Testnet sandbox returns in ~15-20s; mainnet Arc-outbound standard is ~15 min.)
6. **Mint** — agent submits the attested message to `MessageTransmitterV2.receiveMessage` on Base Sepolia, USDC is minted to the agent.
7. **Slippage decision** — off-chain settler computes `breach = latencyMs > 900_000 OR slippageBps > 50`.
8. **Settle** — `PactSettler.settleBatch` on Arc records premium, latency, breach, and pays out a refund if breached.

## Live contracts on Arc Testnet

These are the addresses the agent exercises end-to-end. They are deployed in production from the Pact Network protocol repo (Phase-07b deploy, 2026-05-19) — nothing new was deployed for this hackathon.

| Contract | Address |
|---|---|
| `PactRegistry` | [`0x60e51f2c8c162ec13c7c7234fc9490936127f01b`](https://testnet.arcscan.app/address/0x60e51f2c8c162ec13c7c7234fc9490936127f01b) |
| `PactPool`     | [`0xc5d4c573828e998695b6bd5577947bc77a8f7f97`](https://testnet.arcscan.app/address/0xc5d4c573828e998695b6bd5577947bc77a8f7f97) |
| `PactSettler`  | [`0xccf30140d74cc0d384800501506d50fe622ae963`](https://testnet.arcscan.app/address/0xccf30140d74cc0d384800501506d50fe622ae963) |
| Arc Testnet USDC | `0x3600000000000000000000000000000000000000` (6 decimals, native gas) |
| Arc CCTP v2 `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` (domain `26`) |
| Arc CCTP v2 `MessageTransmitterV2` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (domain `6`) |

## Run it

Prereqs: Node `>= 20`, one funded EOA on Arc Testnet (the demo uses the same wallet for AUTHORITY/SETTLER/AGENT roles, but you can split them via separate `*_PRIVATE_KEY` env vars). ~3 USDC on Arc Testnet from [faucet.circle.com](https://faucet.circle.com/), ~0.001 ETH on Base Sepolia for `receiveMessage` gas.

```bash
cp examples/agora-arc-arbitrage/.env.example .env
# fill AUTHORITY_PRIVATE_KEY / SETTLER_PRIVATE_KEY / AGENT_PRIVATE_KEY
pnpm install                          # or npm install
pnpm preflight                        # verify balances + contract reachability, no state change
pnpm dashboard                        # http://localhost:8910 (separate terminal)
pnpm agent                            # one full insured CCTP burn end-to-end
```

For full walkthrough, env-var reference, faucet links, and troubleshooting, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Receipts — happy path, 2026-05-25 canonical run

```
Date:   2026-05-25
Chain:  Arc Testnet (5042002) → Base Sepolia (84532)
Slug:   arc-cctp-base
CallId: 0x713c87a5414fb679c45ad9504e13cc5f

depositForBurn (Arc)              https://testnet.arcscan.app/tx/0x19f62f49ad2011c809cca2ff037937013995bb5d3b9cb404d7a845915f528fd8
Iris attestation                  16.2s, nonce 0x1c2dcdba99b840ed36541513d6c2c93f0e33addc9ebe4172e35176899aa37cb2
receiveMessage (Base Sepolia)     https://sepolia.basescan.org/tx/0x6ad3e4483fd31aebb74d8969b77b12633a181827fdaec090f26083a3331e8d14
settleBatch PASS (Arc)            https://testnet.arcscan.app/tx/0xf434771d1a63869cac20db53f3973eaac4f56272f84e853ecad4eece6c4b6798
                                  premium 0.050000 USDC kept by pool, refund 0.000000 USDC, status=PASS
slippage:                         0 bps (threshold 50)
latency:                          16170 ms (threshold 900000)
```

Run-time: ~30 seconds end-to-end. (Mainnet Arc-outbound CCTP is the ~15-min standard window; the sandbox Iris returns much faster.)

## How the insurance triggers

The off-chain settler computes:

```
breach = latencyMs > 900_000 OR slippageBps > 50
```

`PactSettler.settleBatch` accepts both `latencyMs` and `breach` as independent inputs from the SETTLER role. The contract does not enforce `latencyMs > slaLatencyMs implies breach == true`. That means the breach formula can combine any number of off-chain dimensions (latency, slippage, status code, schema diff) without changing the on-chain contract. For Agora the formula is two-dimensional.

To demonstrate the breach path quickly without waiting on a real bridge outage, set `IRIS_POLL_TIMEOUT_S=5` — the agent will fall into the `IrisDeadlineExceeded` path and submit a full-refund settle.

## Stack

- TypeScript agent on `viem`, inline CCTP v2 ABI fragments for `depositForBurn` + `receiveMessage`
- Iris sandbox attestation polling at `https://iris-api-sandbox.circle.com/v2/messages/26`
- Static HTML + ES module dashboard polling Arc RPC for `PactPool.balanceOf(slug)` and the last `CallSettled` events
- Arc Testnet RPC `https://rpc.testnet.arc.network`, Base Sepolia RPC `https://sepolia.base.org`
- Pact protocol contracts deployed via Foundry (Phase-07b, 2026-05-19) — no compile step needed for this hackathon

## What is stubbed

- The agent EOA is a freshly funded throwaway key, not a deployed agent runtime.
- The off-chain SETTLER is a single EOA for the hackathon. V2 replaces it with a cross-chain proof oracle that verifies the CCTP burn on Arc and the destination mint independently.
- The slippage signal is computed off-chain. The on-chain `CallSettled` event carries `latencyMs` and the boolean `breach`; the dashboard shows the slippage math.
- Pool capital for the demo is a Pact-funded ~3 USDC top-up. Production pool sizing follows the audit and the Arc mainnet TVL ramp.
- Price gap defaults to a deterministic mock so replays produce the same hero number. Set `PRICE_SOURCE=coingecko` for live (still synthetic) gap data.

## Roadmap after the hackathon

- Krexa lending wedge on Solana mainnet — 2026-07-31
- EURC pair on Arc for an FX-routing variant of the same demo
- Gateway integration so an Arc-side refund can be backed by Solana-side pool capital without bridging exposure
- Cross-chain proof oracle to remove the SETTLER EOA trust assumption

## Contact

- Email: rick@quantum3labs.com
- Telegram: [t.me/metalboyrick](https://t.me/metalboyrick)

## License

Apache-2.0.
