// All on-chain reads for this app. No backend: every call goes straight from the browser to
// the Hiro API (hiro.ts handles key, timeout, retry and concurrency).
//
// Two rules, both learned the hard way in this project:
// 1. A failed read is UNKNOWN, never zero. Parsers throw on an unexpected shape instead of
//    defaulting. (The main repo's Sep 15 incident: failed reads silently became literal 0.00
//    and drove a wrong decision.)
// 2. Each value is read and reported independently (readFields), so one failed call leaves
//    one number stale instead of throwing away the whole refresh, which is what Promise.all
//    used to do on a single rejection.

import { Cl, ClarityValue, cvToJSON, fetchCallReadOnlyFunction } from "@stacks/transactions";
import { HIRO_API_BASE, TOKEN_CONTRACT_NAME, VAULT_ADDRESS, VAULT_CONTRACT_NAME } from "./config";
import { hiroCall, hiroFetch, hiroGetJson } from "./hiro";

async function readOnly(contractName: string, functionName: string, args: ClarityValue[] = [], senderAddress: string = VAULT_ADDRESS): Promise<any> {
  const result = await hiroCall(() =>
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

// ---------------------------------------------------------------------------
// Strict parsers over cvToJSON output
// ---------------------------------------------------------------------------

function fail(what: string): never {
  throw new Error(`unexpected response shape for ${what}`);
}
const uintOf = (v: any, what: string): bigint => (v?.type === "uint" ? BigInt(v.value) : fail(what));
const intOf = (v: any, what: string): bigint => (v?.type === "int" ? BigInt(v.value) : fail(what));
const boolOf = (v: any, what: string): boolean => (v?.type === "bool" && typeof v.value === "boolean" ? v.value : fail(what));
const principalOf = (v: any, what: string): string => (v?.type === "principal" && typeof v.value === "string" ? v.value : fail(what));
const okOf = (j: any, what: string): any => (j?.success === true ? j.value : fail(what));

// get-total-assets / get-free-balance return a BARE uint; every other getter wraps its value
// in (ok ...). Kept as distinct parsers on purpose: mixing them up was a real bug in this
// project's CLI tooling.
const bareUint = (j: any, what: string) => uintOf(j, what);
const okUint = (j: any, what: string) => uintOf(okOf(j, what), what);
const okInt = (j: any, what: string) => intOf(okOf(j, what), what);
const okBool = (j: any, what: string) => boolOf(okOf(j, what), what);
const okPrincipal = (j: any, what: string) => principalOf(okOf(j, what), what);

export interface PendingChange<T> {
  value: T;
  executableAt: number; // stacks-block-height from which it can take effect
}

// (ok (optional { value: T, executable-at: uint }))
function okPending<T>(j: any, what: string, valueOf: (v: any, what: string) => T): PendingChange<T> | null {
  const opt = okOf(j, what);
  if (typeof opt?.type !== "string" || !opt.type.startsWith("(optional")) fail(what);
  if (opt.value === null) return null;
  const fields = opt.value?.value;
  if (!fields) fail(what);
  return { value: valueOf(fields.value, what), executableAt: Number(uintOf(fields["executable-at"], what)) };
}

// ---------------------------------------------------------------------------
// Independent multi-field reads
// ---------------------------------------------------------------------------

export interface FieldResults<T> {
  values: Partial<T>;
  failed: (keyof T)[];
}

async function readFields<T>(spec: { [K in keyof T]: () => Promise<T[K]> }): Promise<FieldResults<T>> {
  const keys = Object.keys(spec) as (keyof T)[];
  const settled = await Promise.allSettled(keys.map((k) => spec[k]()));
  const values: Partial<T> = {};
  const failed: (keyof T)[] = [];
  settled.forEach((r, i) => {
    const k = keys[i];
    if (r.status === "fulfilled") values[k] = r.value;
    else {
      failed.push(k);
      console.warn(`read failed: ${String(k)}`, r.reason);
    }
  });
  return { values, failed };
}

const getter =
  <R>(functionName: string, parse: (j: any, what: string) => R, contractName = VAULT_CONTRACT_NAME) =>
  async (): Promise<R> =>
    parse(await readOnly(contractName, functionName), functionName);

// Amounts are base units (uSTX, or dsSTX for shares), as bigint.
export interface VaultLive {
  depositsPaused: boolean;
  strategyPaused: boolean;
  totalStxBalance: bigint; // STX held by the vault contract right now
  capitalAtStrategy: bigint; // STX swept out to the strategy, counted at the amount sent
  totalAssets: bigint; // the two above: what the cap and the share price use
  freeBalance: bigint; // held minus reserved for accepted withdrawals: what a new request can draw on
  totalPendingWithdrawals: bigint;
  cumulativeRealizedPnl: bigint; // signed
  highWaterMark: bigint; // signed
  shareSupply: bigint;
}

export function readVaultLive(): Promise<FieldResults<VaultLive>> {
  return readFields<VaultLive>({
    depositsPaused: getter("get-deposits-paused", okBool),
    strategyPaused: getter("get-strategy-paused", okBool),
    totalStxBalance: getter("get-total-stx-balance", okUint),
    capitalAtStrategy: getter("get-capital-at-strategy", okUint),
    totalAssets: getter("get-total-assets", bareUint),
    freeBalance: getter("get-free-balance", bareUint),
    totalPendingWithdrawals: getter("get-total-pending-withdrawals", okUint),
    cumulativeRealizedPnl: getter("get-cumulative-realized-pnl", okInt),
    highWaterMark: getter("get-high-water-mark", okInt),
    shareSupply: getter("get-total-supply", okUint, TOKEN_CONTRACT_NAME),
  });
}

// Timelocked parameters and their queued changes. These can only change after a public wait
// of TIMELOCK_DELAY_BLOCKS, so they're read less often than VaultLive (see config.ts).
export interface VaultSettings {
  admin: string;
  maxTvl: bigint;
  performanceFeeBps: number;
  feeRecipient: string;
  pendingMaxTvl: PendingChange<bigint> | null;
  pendingFeeBps: PendingChange<number> | null;
  pendingFeeRecipient: PendingChange<string> | null;
  pendingAdmin: PendingChange<string> | null;
}

export function readVaultSettings(): Promise<FieldResults<VaultSettings>> {
  const bps = (v: any, what: string) => Number(uintOf(v, what));
  return readFields<VaultSettings>({
    admin: getter("get-admin", okPrincipal),
    maxTvl: getter("get-max-tvl", okUint),
    performanceFeeBps: getter("get-performance-fee-bps", (j, w) => Number(okUint(j, w))),
    feeRecipient: getter("get-fee-recipient", okPrincipal),
    pendingMaxTvl: getter("get-pending-max-tvl", (j, w) => okPending(j, w, uintOf)),
    pendingFeeBps: getter("get-pending-fee-bps", (j, w) => okPending(j, w, bps)),
    pendingFeeRecipient: getter("get-pending-fee-recipient", (j, w) => okPending(j, w, principalOf)),
    pendingAdmin: getter("get-pending-admin", (j, w) => okPending(j, w, principalOf)),
  });
}

// ---------------------------------------------------------------------------
// Per-user reads
// ---------------------------------------------------------------------------

export async function readShareBalance(address: string): Promise<bigint> {
  return okUint(await readOnly(TOKEN_CONTRACT_NAME, "get-balance", [Cl.principal(address)], address), "get-balance");
}

export interface WithdrawalRequest {
  id: number;
  owner: string;
  shares: bigint; // dsSTX escrowed by the request, burned at claim
  lockedStx: bigint; // uSTX the request is entitled to, fixed at request time
  claimableAt: number; // stacks-block-height
  claimed: boolean;
}

export async function readWithdrawalRequest(id: number): Promise<WithdrawalRequest | null> {
  const what = `get-withdrawal-request ${id}`;
  const opt = okOf(await readOnly(VAULT_CONTRACT_NAME, "get-withdrawal-request", [Cl.uint(id)]), what); // (optional (tuple ...))
  if (typeof opt?.type !== "string" || !opt.type.startsWith("(optional")) fail(what);
  if (opt.value === null) return null;
  const t = opt.value?.value;
  if (!t) fail(what);
  return {
    id,
    owner: principalOf(t.owner, what),
    shares: uintOf(t.shares, what),
    lockedStx: uintOf(t["locked-stx-amount"], what),
    claimableAt: Number(uintOf(t["claimable-at"], what)),
    claimed: boolOf(t.claimed, what),
  };
}

// ---------------------------------------------------------------------------
// Chain state
// ---------------------------------------------------------------------------

export async function readCurrentBlockHeight(): Promise<number> {
  const h = Number((await hiroGetJson(HIRO_API_BASE, "/v2/info"))?.stacks_tip_height);
  if (!(h > 0)) throw new Error("/v2/info returned no stacks_tip_height");
  return h;
}

export async function readNetworkId(): Promise<number> {
  const id = Number((await hiroGetJson(HIRO_API_BASE, "/v2/info"))?.network_id);
  if (!Number.isFinite(id)) throw new Error("/v2/info returned no network_id");
  return id;
}

// Real seconds per block over the most recent `window` blocks, from the chain's own block
// timestamps (two requests). Every duration shown to a user is a block count converted with
// this, never a fixed assumption. The contract was sized for 15.25 s/block; mainnet ran at
// 13.38 over withdrawal #0's delay (see config.ts).
export async function measureSecPerBlock(window: number): Promise<number> {
  const latest = (await hiroGetJson(HIRO_API_BASE, "/extended/v2/blocks?limit=1"))?.results?.[0];
  const tipHeight = Number(latest?.height);
  const tipTime = Number(latest?.block_time);
  if (!(tipHeight > window) || !(tipTime > 0)) throw new Error("couldn't read the latest block");
  const pastTime = Number((await hiroGetJson(HIRO_API_BASE, `/extended/v2/blocks/${tipHeight - window}`))?.block_time);
  if (!(pastTime > 0)) throw new Error("couldn't read a past block's time");
  const secPerBlock = (tipTime - pastTime) / window;
  if (!(secPerBlock >= 2 && secPerBlock <= 120)) throw new Error(`implausible block pace: ${secPerBlock}`);
  return secPerBlock;
}
