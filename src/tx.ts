// Poll the Hiro API for a broadcast transaction's confirmation + parsed Clarity return value.
// No websocket/backend — plain polling, same pattern this project's own CLI tooling uses.

import { HIRO_API_BASE, HIRO_API_KEY } from "./config";

// Same fix as reads.ts's hiroFetch() -- always wrap, never hand back the bare native `fetch`
// reference. This file's own call sites happen to call it as a free function (safe either
// way), but keeping both copies identical means that stops being true by accident if either
// ever changes.
function hiroFetch(): typeof fetch {
  const key = HIRO_API_KEY;
  return ((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(url, key ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-api-key": key } } : init)) as typeof fetch;
}

export interface TxOutcome {
  status: "success" | "abort_by_response" | "abort_by_post_condition" | "timeout" | string;
  repr?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForTx(txid: string, onTick?: (attempt: number) => void): Promise<TxOutcome> {
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    onTick?.(i);
    try {
      const res = await hiroFetch()(`${HIRO_API_BASE}/extended/v1/tx/${txid}`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.tx_status && j.tx_status !== "pending") {
        return { status: j.tx_status, repr: j.tx_result?.repr };
      }
    } catch {
      // transient — keep polling rather than failing on one bad poll
    }
  }
  return { status: "timeout" };
}

// Parses a Clarity `(ok u0)` style repr string into the plain number inside, for the one place
// this app needs a contract's RETURN VALUE (request-withdrawal's assigned id) rather than just
// pass/fail. Returns null on anything that doesn't match this exact shape rather than guessing.
export function parseOkUintRepr(repr: string | undefined): number | null {
  if (!repr) return null;
  const m = repr.match(/^\(ok u(\d+)\)$/);
  return m ? Number(m[1]) : null;
}
