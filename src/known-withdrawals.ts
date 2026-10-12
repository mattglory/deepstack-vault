// The contract has no per-user index, so the site remembers what it saw this browser create:
// idle request ids and the epochs the user queued into. Keyed by vault + address, so testnet
// and mainnet data never mix. The manual "check a request by id" lookup covers other devices.

import { VAULT_CONTRACT_ID } from "./config";

const KEY = `deepstack-v2-known:${VAULT_CONTRACT_ID}`;
type Store = Record<string, { requests: number[]; epochs: string[] }>;

function load(): Store {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store; } catch { return {}; }
}
function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* best effort */ }
}
function entry(s: Store, addr: string) {
  return (s[addr] ??= { requests: [], epochs: [] });
}
export function rememberRequest(addr: string, id: number): void {
  const s = load(); const e = entry(s, addr);
  if (!e.requests.includes(id)) e.requests.push(id);
  save(s);
}
export function forgetRequest(addr: string, id: number): void {
  const s = load(); const e = entry(s, addr);
  e.requests = e.requests.filter((x) => x !== id);
  save(s);
}
export function rememberEpoch(addr: string, epoch: bigint): void {
  const s = load(); const e = entry(s, addr);
  if (!e.epochs.includes(epoch.toString())) e.epochs.push(epoch.toString());
  save(s);
}
export function knownRequests(addr: string): number[] { return load()[addr]?.requests ?? []; }
export function knownEpochs(addr: string): bigint[] { return (load()[addr]?.epochs ?? []).map((x) => BigInt(x)); }
