/**
 * Iris attestation polling client.
 *
 * After a CCTP burn lands on Arc, Circle's off-chain attestation service
 * (Iris) signs the message; the destination chain only accepts mints once
 * we hand it that signature. For Arc-outbound the wait is ~13-15min on
 * standard threshold (Arc doesn't support Fast Transfer outbound today).
 *
 * Probe results (2026-05-20): ~340ms median response, 404 == not-yet, 200
 * with status:"complete" == ready. Full notes in
 * /dev/docs/pact-network-designs/agora-iris-api-probe.md
 */
import type { Hex } from "viem";

export class IrisDeadlineExceeded extends Error {
  constructor(burnTxHash: string, waitedMs: number) {
    super(`Iris attestation deadline exceeded for burnTxHash=${burnTxHash} (waited ${waitedMs}ms)`);
    this.name = "IrisDeadlineExceeded";
  }
}

export interface IrisAttestation {
  attestation: Hex; // bytes — pass directly to MessageTransmitterV2.receiveMessage(message, attestation)
  message: Hex; // bytes — the CCTP MessageV2 payload
  eventNonce: string;
  status: string;
}

interface IrisRawMessage {
  attestation?: string;
  message?: string;
  eventNonce?: string;
  status?: string;
  cctpVersion?: number;
  decodedMessage?: unknown;
  delayReason?: string | null;
}

interface IrisRawResponse {
  messages?: IrisRawMessage[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll Iris until the attestation for `burnTxHash` is ready or the
 * deadline (unix seconds) is reached.
 *
 * Defaults: 5s poll interval, no max retries (the wall-clock deadline
 * is the only ceiling — typical run takes ~150-180 polls on Arc).
 */
export async function pollAttestation(
  sourceDomain: number,
  burnTxHash: Hex,
  deadlineUnixSec: number,
  opts: { intervalMs?: number; irisBase?: string; onPoll?: (n: number) => void } = {},
): Promise<IrisAttestation> {
  const intervalMs = opts.intervalMs ?? 5000;
  const irisBase = opts.irisBase ?? "https://iris-api-sandbox.circle.com";
  const startedAt = Date.now();
  let polls = 0;

  while (Date.now() / 1000 < deadlineUnixSec) {
    polls += 1;
    opts.onPoll?.(polls);

    const url = `${irisBase}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      // Network blip — wait and retry. Don't escalate (Iris sandbox occasionally drops connections).
      await sleep(intervalMs);
      continue;
    }

    if (res.status === 404) {
      // Normal "not yet" — keep polling.
      await sleep(intervalMs);
      continue;
    }

    if (res.status === 200) {
      const data = (await res.json()) as IrisRawResponse;
      const msg = data.messages?.[0];
      if (msg && msg.status === "complete" && msg.attestation && msg.message) {
        return {
          attestation: msg.attestation as Hex,
          message: msg.message as Hex,
          eventNonce: msg.eventNonce ?? "",
          status: msg.status,
        };
      }
      // 200 but not complete yet (pending_confirmations etc.) — keep polling.
      await sleep(intervalMs);
      continue;
    }

    // Any other status is unexpected; surface it loudly so the demo doesn't loop forever.
    const body = await res.text().catch(() => "");
    throw new Error(`Iris returned unexpected status ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }

  throw new IrisDeadlineExceeded(burnTxHash, Date.now() - startedAt);
}
