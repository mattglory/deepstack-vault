// Poll the Hiro API for a broadcast transaction's confirmation + parsed Clarity return value.
// No websocket/backend: plain polling, same pattern this project's own CLI tooling uses.

import { HIRO_API_BASE } from "./config";
import { hiroFetch } from "./hiro";

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
      // transient (including a per-request timeout): keep polling rather than fail on one bad poll
    }
  }
  return { status: "timeout" };
}

// request-withdrawal returns (ok { queued: bool, id: uint }): the idle request id, or the epoch
// the shares were queued into. Hiro renders it as `(ok (tuple (id u3) (queued false)))`. Returns
// null on anything else rather than guessing.
export function parseRequestRepr(repr: string | undefined): { queued: boolean; id: number } | null {
  if (!repr?.startsWith("(ok ")) return null;
  const id = /\(id u(\d+)\)/.exec(repr);
  const q = /\(queued (true|false)\)/.exec(repr);
  return id && q ? { queued: q[1] === "true", id: Number(id[1]) } : null;
}
