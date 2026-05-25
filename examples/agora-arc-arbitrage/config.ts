/**
 * Agora-Arc arb-agent demo — config.
 *
 * Extends the protocol demo's existing Arc config with Base Sepolia (CCTP
 * destination), Circle's CCTP v2 contracts on both sides, and the Iris
 * sandbox API. The Pact contract addresses, USDC address, and Arc chain
 * definition are reused from `../../src/config.ts` unchanged.
 */
import "dotenv/config";
import { defineChain, type Address, type Hex } from "viem";

import { cfg as protocolCfg, loadKeys as loadProtocolKeys } from "../../src/config.js";

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envAddr(name: string, fallback: string): Address {
  return envOr(name, fallback) as Address;
}

function envKey(name: string, fallback?: Hex): Hex {
  const raw = process.env[name];
  if (!raw || raw.length === 0) {
    if (fallback) return fallback;
    throw new Error(`Missing required env: ${name}`);
  }
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Env ${name} must be a 32-byte hex private key`);
  }
  return hex as Hex;
}

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const baseSepolia = defineChain({
  id: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [envOr("BASE_RPC_URL", "https://sepolia.base.org")] },
  },
  blockExplorers: {
    default: { name: "BaseScan", url: "https://sepolia.basescan.org" },
  },
  testnet: true,
});

/**
 * Agora-side config. Merges the protocol demo's `cfg` with the additional
 * Circle CCTP + Base Sepolia surface area this demo needs.
 */
export const cfg = {
  // --- Arc side (reused from src/config.ts) ---
  arc: {
    chain: protocolCfg.chain,
    rpcUrl: protocolCfg.rpcUrl,
    usdc: protocolCfg.usdc,
    registry: protocolCfg.registry,
    pool: protocolCfg.pool,
    settler: protocolCfg.settler,
  },

  // --- Base Sepolia side (new) ---
  base: {
    chain: baseSepolia,
    rpcUrl: envOr("BASE_RPC_URL", "https://sepolia.base.org"),
    usdc: envAddr("BASE_USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  },

  // --- CCTP v2 contracts (same CREATE2 address on both chains) ---
  cctp: {
    tokenMessenger: envAddr("CCTP_TOKEN_MESSENGER", "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"),
    messageTransmitter: envAddr("CCTP_MESSAGE_TRANSMITTER", "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"),
    arcDomain: Number(envOr("ARC_SOURCE_DOMAIN", "26")),
    baseDomain: Number(envOr("BASE_SEPOLIA_DEST_DOMAIN", "6")),
  },

  // --- Iris attestation API ---
  iris: {
    base: envOr("IRIS_API_BASE", "https://iris-api-sandbox.circle.com"),
    pollIntervalMs: Number(envOr("IRIS_POLL_INTERVAL_MS", "5000")),
    pollTimeoutS: Number(envOr("IRIS_POLL_TIMEOUT_S", "1800")), // 30 min
  },

  // --- Demo parameters ---
  demo: {
    // Distinct slug so we don't collide with the protocol demo's slug.
    slug: envOr("DEMO_SLUG", "arc-base-cctp-usdc"),
    principal: BigInt(envOr("DEMO_PRINCIPAL_USDC", "1000000")), // 1.00 USDC
    premium: BigInt(envOr("DEMO_PREMIUM_USDC", "50000")), // 0.05 USDC
    poolTopUp: BigInt(envOr("DEMO_TOPUP_USDC", "2000000")), // 2.00 USDC headroom for refunds
    slaThresholdBps: Number(envOr("DEMO_SLA_BPS", "50")), // 0.50% slippage tolerance
    slaLatencyMs: Number(envOr("DEMO_SLA_LATENCY_MS", "900000")), // 15min — matches Arc-outbound standard
  },
};

export function loadKeys() {
  const protocol = loadProtocolKeys();
  // Reuse the protocol keys but expose them under arb-agent names. AGENT_PRIVATE_KEY is
  // the wallet that does the burn on Arc and the mint on Base; SETTLER and AUTHORITY are
  // reused unchanged from the protocol demo for the slug/role/pool setup steps.
  const arcKey = envKey("ARC_PRIVATE_KEY", protocol.agent);
  const baseKey = envKey("BASE_PRIVATE_KEY", arcKey); // default: reuse Arc key on Base
  return {
    authority: protocol.authority,
    settler: protocol.settler,
    arcAgent: arcKey,
    baseAgent: baseKey,
  };
}

export function arcExplorerTx(hash: Hex): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

export function baseExplorerTx(hash: Hex): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}
