// All on-chain reads for this app — no backend, every call goes straight from the browser to
// the Hiro API via fetchCallReadOnlyFunction. See config.ts for the API key wiring.

import { Cl, ClarityValue, cvToJSON, fetchCallReadOnlyFunction } from "@stacks/transactions";
import { HIRO_API_BASE, HIRO_API_KEY, TOKEN_CONTRACT_NAME, VAULT_ADDRESS, VAULT_CONTRACT_NAME } from "./config";

// Always returns a NEW wrapper function, never the bare native `fetch` reference. Callers
// (fetchCallReadOnlyFunction) invoke this as `client.fetch(url, init)` -- a method call on an
// object, not `window.fetch(...)`. Native fetch throws "Illegal invocation" when called with
// any `this` other than window/the realm global, so handing back the bare reference broke
// every read in production the moment HIRO_API_KEY was unset (caught live, 2026-10-06 --
// typecheck/build can't catch this, since it's only wrong at the call site, not the type).
function hiroFetch(): typeof fetch {
  const key = HIRO_API_KEY;
  return ((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(url, key ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-api-key": key } } : init)) as typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// readVaultStatus() fires 13 read-only calls at once (plus a block-height read alongside it) —
// without a Hiro API key (unauthenticated traffic shares a 50 req/min limit across EVERY call
// to the API, see rpc.ts in the main deepstack repo for the same concern on the backend side),
// a burst this size can trip rate-limiting, which surfaces to the browser as a generic CORS
// failure rather than a clear 429 (caught live, 2026-10-07 -- a real wallet, a real burst of
// calls, all 13 failing together). Promise.all fails the WHOLE batch on any single rejection,
// so one flaky call was taking down the entire vault-stats panel. Retrying each call
// independently, with jittered backoff so the 13 retries desynchronize instead of re-bursting
// in lockstep, fixes both problems without needing a second API provider.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(800 + Math.random() * 1200 * (i + 1));
    }
  }
  throw lastErr;
}

async function readOnly(contractName: string, functionName: string, args: ClarityValue[] = [], senderAddress = VAULT_ADDRESS) {
  const result = await withRetry(() =>
    fetchCallReadOnlyFunction({
      contractAddress: VAULT_ADDRESS,
      contractName,
      functionName,
      functionArgs: args,
      network: "mainnet",
      senderAddress,
      client: { baseUrl: HIRO_API_BASE, fetch: hiroFetch() },
    }),
  );
  return cvToJSON(result);
}

// get-total-assets / get-free-balance return a bare uint (no `(ok ...)` wrapper) — every other
// vault getter wraps its value in `(ok ...)`. Mixing these up was a real bug caught in this
// project's own CLI tooling; kept as two distinct helpers on purpose so it can't happen here.
const bareUint = (j: any): number => Number(j?.value ?? 0);
const okUint = (j: any): number => Number(j?.value?.value ?? 0);
const okInt = (j: any): number => Number(j?.value?.value ?? 0);
const okBool = (j: any): boolean => Boolean(j?.value?.value);
const okPrincipal = (j: any): string => String(j?.value?.value ?? "");

export interface VaultStatus {
  admin: string;
  maxTvlStx: number;
  performanceFeeBps: number;
  feeRecipient: string;
  depositsPaused: boolean;
  strategyPaused: boolean;
  totalStxBalance: number; // vault-held STX, excludes capital-at-strategy
  capitalAtStrategy: number;
  totalAssetsStx: number; // totalStxBalance + capitalAtStrategy — what the cap applies to
  totalPendingWithdrawals: number;
  cumulativeRealizedPnlStx: number;
  highWaterMarkStx: number;
  tokenTotalSupply: number; // shares outstanding, 1:1 base units with STX
}

export async function readVaultStatus(): Promise<VaultStatus> {
  const [admin, maxTvl, feeBps, feeRecipient, depositsPaused, strategyPaused, totalBal, atStrategy, totalAssets, pendingWd, pnl, hwm, supply] = await Promise.all([
    readOnly(VAULT_CONTRACT_NAME, "get-admin"),
    readOnly(VAULT_CONTRACT_NAME, "get-max-tvl"),
    readOnly(VAULT_CONTRACT_NAME, "get-performance-fee-bps"),
    readOnly(VAULT_CONTRACT_NAME, "get-fee-recipient"),
    readOnly(VAULT_CONTRACT_NAME, "get-deposits-paused"),
    readOnly(VAULT_CONTRACT_NAME, "get-strategy-paused"),
    readOnly(VAULT_CONTRACT_NAME, "get-total-stx-balance"),
    readOnly(VAULT_CONTRACT_NAME, "get-capital-at-strategy"),
    readOnly(VAULT_CONTRACT_NAME, "get-total-assets"),
    readOnly(VAULT_CONTRACT_NAME, "get-total-pending-withdrawals"),
    readOnly(VAULT_CONTRACT_NAME, "get-cumulative-realized-pnl"),
    readOnly(VAULT_CONTRACT_NAME, "get-high-water-mark"),
    readOnly(TOKEN_CONTRACT_NAME, "get-total-supply"),
  ]);
  return {
    admin: okPrincipal(admin),
    maxTvlStx: okUint(maxTvl) / 1e6,
    performanceFeeBps: okUint(feeBps),
    feeRecipient: okPrincipal(feeRecipient),
    depositsPaused: okBool(depositsPaused),
    strategyPaused: okBool(strategyPaused),
    totalStxBalance: okUint(totalBal) / 1e6,
    capitalAtStrategy: okUint(atStrategy) / 1e6,
    totalAssetsStx: bareUint(totalAssets) / 1e6,
    totalPendingWithdrawals: okUint(pendingWd) / 1e6,
    cumulativeRealizedPnlStx: okInt(pnl) / 1e6,
    highWaterMarkStx: okInt(hwm) / 1e6,
    tokenTotalSupply: okUint(supply) / 1e6,
  };
}

export async function readShareBalance(address: string): Promise<number> {
  const j = await readOnly(TOKEN_CONTRACT_NAME, "get-balance", [Cl.principal(address)], address);
  return okUint(j) / 1e6;
}

export interface WithdrawalRequest {
  id: number;
  owner: string;
  shares: number;
  lockedStxAmount: number;
  claimableAt: number; // stacks-block-height
  claimed: boolean;
}

export async function readWithdrawalRequest(id: number): Promise<WithdrawalRequest | null> {
  const j = await readOnly(VAULT_CONTRACT_NAME, "get-withdrawal-request", [Cl.uint(id)]);
  const opt = j?.value; // (ok (optional (tuple ...)))
  const tuple = opt?.value?.value;
  if (!tuple) return null;
  return {
    id,
    owner: String(tuple.owner?.value ?? ""),
    shares: Number(tuple.shares?.value ?? 0) / 1e6,
    lockedStxAmount: Number(tuple["locked-stx-amount"]?.value ?? 0) / 1e6,
    claimableAt: Number(tuple["claimable-at"]?.value ?? 0),
    claimed: Boolean(tuple.claimed?.value),
  };
}

export async function readCurrentBlockHeight(): Promise<number> {
  return withRetry(async () => {
    const res = await hiroFetch()(`${HIRO_API_BASE}/v2/info`);
    if (!res.ok) throw new Error(`/v2/info failed: ${res.status}`);
    const j = await res.json();
    return Number(j.stacks_tip_height ?? 0);
  });
}

export async function readNetworkId(): Promise<number> {
  return withRetry(async () => {
    const res = await hiroFetch()(`${HIRO_API_BASE}/v2/info`);
    if (!res.ok) throw new Error(`/v2/info failed: ${res.status}`);
    const j = await res.json();
    return Number(j.network_id ?? 0);
  });
}
