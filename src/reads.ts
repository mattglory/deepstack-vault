// All on-chain reads for the v2 site. No backend: every call goes from the browser to the Hiro
// API (hiro.ts: timeout, retry, concurrency cap). A failed read is UNKNOWN, never zero: the
// converter throws on anything unexpected and callers keep their last good value.

import { Cl, ClarityValue, fetchCallReadOnlyFunction } from "@stacks/transactions";
import { HIRO_API_BASE, NETWORK, TOKEN_CONTRACT_NAME, VAULT_ADDRESS, VAULT_CONTRACT_NAME } from "./config";
import { hiroCall, hiroFetch, hiroGetJson } from "./hiro";

// ClarityValue -> plain JS (bigint for numbers). Throws on (err ...) so failures surface.
function js(cv: any): any {
  switch (cv?.type) {
    case "uint": case "int": return BigInt(cv.value);
    case "true": return true;
    case "false": return false;
    case "address": case "contract": return cv.value;
    case "none": return null;
    case "some": case "ok": return js(cv.value);
    case "err": throw new Error(`contract returned err ${String(cv.value?.value ?? "")}`);
    case "tuple": return Object.fromEntries(Object.entries(cv.value).map(([k, v]) => [k, js(v)]));
    case "ascii": case "utf8": return cv.value;
    default: throw new Error(`unexpected Clarity value type: ${cv?.type}`);
  }
}

async function ro(functionName: string, args: ClarityValue[] = [], contractName = VAULT_CONTRACT_NAME, sender = VAULT_ADDRESS): Promise<any> {
  const result = await hiroCall(() =>
    fetchCallReadOnlyFunction({
      contractAddress: VAULT_ADDRESS, contractName, functionName, functionArgs: args,
      network: NETWORK, senderAddress: sender, client: { baseUrl: HIRO_API_BASE, fetch: hiroFetch() },
    }),
  );
  return js(result);
}

export interface VaultState {
  initialized: boolean; admin: string; strategy: string; guardian: string; feeRecipient: string;
  maxTvl: bigint; feeBps: bigint; maxDeployBps: bigint;
  depositsPaused: boolean; sweepsPaused: boolean;
  vaultStx: bigint; capitalAtStrategy: bigint; pendingDeposits: bigint; ringfenced: bigint;
  totalAssets: bigint; supply: bigint; pps: bigint; hwmPps: bigint; sweepRefPps: bigint;
  realizedPnl: bigint; currentEpoch: bigint; epochOpen: boolean; overdue: boolean; noChangePending: boolean;
}

export async function readState(): Promise<VaultState> {
  const s = await ro("get-state");
  const need = (k: string) => {
    if (!(k in s)) throw new Error(`get-state missing ${k}`);
    return s[k];
  };
  return {
    initialized: need("initialized"), admin: need("admin"), strategy: need("strategy"), guardian: need("guardian"),
    feeRecipient: need("fee-recipient"), maxTvl: need("max-tvl"), feeBps: need("fee-bps"), maxDeployBps: need("max-deploy-bps"),
    depositsPaused: need("deposits-paused"), sweepsPaused: need("sweeps-paused"), vaultStx: need("vault-stx"),
    capitalAtStrategy: need("capital-at-strategy"), pendingDeposits: need("pending-deposits"), ringfenced: need("ringfenced"),
    totalAssets: need("total-assets"), supply: need("supply"), pps: need("pps"), hwmPps: need("hwm-pps"),
    sweepRefPps: need("sweep-ref-pps"), realizedPnl: need("realized-pnl"), currentEpoch: need("current-epoch"),
    epochOpen: need("epoch-open"), overdue: need("overdue"), noChangePending: need("no-change-pending"),
  };
}

export interface PendingChange { param: string; value: string | bigint | null; executableAt: bigint }

export async function readPendingChanges(): Promise<PendingChange[]> {
  const p = await ro("get-pending-changes");
  const out: PendingChange[] = [];
  for (const [param, v] of Object.entries(p) as [string, any][]) {
    if (v === null) continue;
    if (param === "resume") out.push({ param: "resume-sweeps", value: null, executableAt: v as bigint });
    else out.push({ param, value: v.value, executableAt: v["executable-at"] });
  }
  return out;
}

export async function readShareBalance(address: string): Promise<bigint> {
  return ro("get-balance", [Cl.principal(address)], TOKEN_CONTRACT_NAME, address);
}

export interface IdleRequest { id: number; owner: string; amount: bigint; claimableAt: bigint }
export async function readRequest(id: number): Promise<IdleRequest | null> {
  const r = await ro("get-request", [Cl.uint(id)]);
  return r ? { id, owner: r.owner, amount: r.amount, claimableAt: r["claimable-at"] } : null;
}

export interface Epoch {
  id: bigint; startBurn: bigint; deployed: bigint; depTotal: bigint; wdSharesTotal: bigint; settled: boolean;
  depSharesMinted: bigint; wdStxPaid: bigint; writtenOff: boolean;
}
export async function readEpoch(id: bigint): Promise<Epoch | null> {
  const e = await ro("get-epoch", [Cl.uint(id)]);
  if (!e) return null;
  return {
    id, startBurn: e["start-burn"], deployed: e.deployed, depTotal: e["dep-total"], wdSharesTotal: e["wd-shares-total"],
    settled: e.settled, depSharesMinted: e["dep-shares-minted"], wdStxPaid: e["wd-stx-paid"], writtenOff: e["written-off"],
  };
}
export const readEpochDeposit = (e: bigint, user: string): Promise<bigint> => ro("get-epoch-deposit", [Cl.uint(e), Cl.principal(user)]);
export const readEpochWithdrawal = (e: bigint, user: string): Promise<bigint> => ro("get-epoch-withdrawal", [Cl.uint(e), Cl.principal(user)]);

export async function readChainInfo(): Promise<{ burnHeight: bigint; networkId: number }> {
  const j = await hiroGetJson(HIRO_API_BASE, "/v2/info");
  const burn = Number(j?.burn_block_height);
  const nid = Number(j?.network_id);
  if (!(burn > 0) || !Number.isFinite(nid)) throw new Error("/v2/info returned incomplete data");
  return { burnHeight: BigInt(burn), networkId: nid };
}
export async function readNetworkId(): Promise<number> {
  return (await readChainInfo()).networkId;
}
