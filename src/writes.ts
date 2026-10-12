// Every broadcast is signed by the CONNECTED USER's own wallet via @stacks/connect request().
//
// Deny mode with exact post-conditions on every call, covering EVERY asset that moves, the
// vault contract's own transfers included. In Deny mode the node aborts a transaction if any
// principal moves an undeclared asset (stacks-core check_transaction_postconditions), and a
// burn counts as the burner sending. v1 shipped a claim with none and would have aborted every
// UI claim (review finding M2); the amounts below come from the same integer math the
// contract uses, read fresh right before signing.

import { Cl, Pc, type PostCondition } from "@stacks/transactions";
import { NETWORK, SHARE_TOKEN_NAME, TOKEN_CONTRACT_ID, VAULT_CONTRACT_ID } from "./config";
import { readEpoch, readEpochDeposit, readEpochWithdrawal, readRequest } from "./reads";

export interface TxResult { txid?: string }

async function call(functionName: string, functionArgs: ReturnType<typeof Cl.uint>[], postConditions: PostCondition[]): Promise<TxResult> {
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: VAULT_CONTRACT_ID, functionName, functionArgs, network: NETWORK,
    postConditions, postConditionMode: "deny",
  });
}

const userStx = (user: string, amt: bigint) => Pc.principal(user).willSendEq(amt).ustx();
const userShares = (user: string, amt: bigint) => Pc.principal(user).willSendEq(amt).ft(TOKEN_CONTRACT_ID, SHARE_TOKEN_NAME);
const vaultStx = (amt: bigint) => Pc.principal(VAULT_CONTRACT_ID).willSendEq(amt).ustx();
const vaultShares = (amt: bigint) => Pc.principal(VAULT_CONTRACT_ID).willSendEq(amt).ft(TOKEN_CONTRACT_ID, SHARE_TOKEN_NAME);

// Idle: STX in, shares minted (mints are not post-condition-checked). Deployed: STX in, queued.
export const deposit = (user: string, amount: bigint) =>
  call("deposit", [Cl.uint(amount)], [userStx(user, amount)]);

// Idle: the user's shares are burned (a burn is the burner sending). Deployed: the user's
// shares move into the vault's escrow. Either way the user sends exactly `shares`.
export const requestWithdrawal = (user: string, shares: bigint) =>
  call("request-withdrawal", [Cl.uint(shares)], [userShares(user, shares)]);

// Idle request claim: the vault pays the fixed amount.
export async function claimIdle(user: string, id: number): Promise<TxResult> {
  const r = await readRequest(id);
  if (!r) throw new Error(`request #${id} not found (already claimed?)`);
  if (r.owner !== user) throw new Error(`request #${id} belongs to another address`);
  return call("claim-withdrawal", [Cl.uint(id)], [vaultStx(r.amount)]);
}

// Epoch deposit claim: shares from escrow, or a 1:1 STX refund if the epoch was written off.
export async function claimEpochDeposit(user: string, e: bigint): Promise<TxResult> {
  const [ep, amt] = await Promise.all([readEpoch(e), readEpochDeposit(e, user)]);
  if (!ep?.settled) throw new Error(`epoch ${e} is not settled yet`);
  if (amt <= 0n) throw new Error(`nothing to claim in epoch ${e}`);
  if (ep.writtenOff) return call("claim-deposit", [Cl.uint(e)], [vaultStx(amt)]);
  const shares = (amt * ep.depSharesMinted) / ep.depTotal;
  return call("claim-deposit", [Cl.uint(e)], [vaultShares(shares)]);
}

// Epoch withdrawal claim: STX at the settled price, or the shares back if written off (D14).
export async function claimEpochWithdrawal(user: string, e: bigint): Promise<TxResult> {
  const [ep, shares] = await Promise.all([readEpoch(e), readEpochWithdrawal(e, user)]);
  if (!ep?.settled) throw new Error(`epoch ${e} is not settled yet`);
  if (shares <= 0n) throw new Error(`nothing to claim in epoch ${e}`);
  if (ep.writtenOff) return call("claim-epoch-withdrawal", [Cl.uint(e)], [vaultShares(shares)]);
  const stx = (shares * ep.wdStxPaid) / ep.wdSharesTotal;
  return call("claim-epoch-withdrawal", [Cl.uint(e)], [vaultStx(stx)]);
}

// Cancels while the epoch is still open: the vault returns exactly what was queued.
export async function cancelDeposit(user: string, e: bigint): Promise<TxResult> {
  const amt = await readEpochDeposit(e, user);
  if (amt <= 0n) throw new Error("no queued deposit to cancel");
  return call("cancel-deposit", [], [vaultStx(amt)]);
}
export async function cancelWithdrawal(user: string, e: bigint): Promise<TxResult> {
  const shares = await readEpochWithdrawal(e, user);
  if (shares <= 0n) throw new Error("no queued withdrawal to cancel");
  return call("cancel-withdrawal", [], [vaultShares(shares)]);
}

// Permissionless once the epoch is overdue (D1/D12/D14). Moves no assets at all: the write-off
// is booked, queued deposits become claimable refunds and queued withdrawals are handed back
// later by the claims above. Deny mode with no post-conditions therefore pins that down.
export const settleOverdue = () => call("settle-overdue", [], []);
