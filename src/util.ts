import { stringToHex, type Hex } from "viem";

export function slugToBytes16(slug: string): Hex {
  const bytes = new TextEncoder().encode(slug);
  if (bytes.length > 16) {
    throw new Error(`endpoint slug must be <= 16 bytes (got ${bytes.length})`);
  }
  return stringToHex(slug, { size: 16 });
}

export function randomCallId(): Hex {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return ("0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

export function fmtUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac} USDC`;
}

export function step(n: number, label: string): void {
  const bar = "─".repeat(64);
  console.log(`\n${bar}\nSTEP ${n} — ${label}\n${bar}`);
}

export function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

export function info(msg: string): void {
  console.log(`  · ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ! ${msg}`);
}
