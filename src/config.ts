import "dotenv/config";
import { defineChain, type Address, type Hex } from "viem";

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function addr(name: string): Address {
  return need(name) as Address;
}

function key(name: string): Hex {
  const raw = need(name);
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Env ${name} must be a 32-byte hex private key`);
  }
  return hex as Hex;
}

function num(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (!v) return fallback;
  return BigInt(v);
}

export const ARC_TESTNET_CHAIN_ID = 5042002;

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const cfg = {
  chain: arcTestnet,
  rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
  registry: addr("PACT_REGISTRY"),
  pool: addr("PACT_POOL"),
  settler: addr("PACT_SETTLER"),
  usdc: addr("ARC_USDC"),
  demoSlug: process.env.DEMO_SLUG ?? "arc-grant-demo",
  topUp: num("DEMO_TOPUP_USDC", 50_000n),
  premium: num("DEMO_PREMIUM_USDC", 10_000n),
  breachRefund: num("DEMO_BREACH_REFUND_USDC", 8_000n),
};

export function loadKeys() {
  return {
    authority: key("AUTHORITY_PRIVATE_KEY"),
    settler: key("SETTLER_PRIVATE_KEY"),
    agent: key("AGENT_PRIVATE_KEY"),
    affiliate: (process.env.AFFILIATE_ADDRESS ?? "") as Address | "",
  };
}

export function explorerTx(hash: Hex): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

export function explorerAddr(a: Address): string {
  return `https://testnet.arcscan.app/address/${a}`;
}
