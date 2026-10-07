// Every broadcast here is signed by the CONNECTED USER's own wallet via @stacks/connect's
// request('stx_callContract', ...). This app never holds or touches a private key.
//
// Post-conditions: exact amounts (willSendEq) in Deny mode on every call. Deny mode means the
// node aborts the transaction if ANY asset moves that isn't declared here. That applies to
// every principal involved, the vault contract included, not just the signer (stacks-core
// check_transaction_postconditions enforces unchecked assets for every principal in Deny
// mode). A burn counts as the burner "sending" the tokens (ft-burn? logs a transfer from the
// burner); a mint is not checked at all.
//
// `request` is dynamically imported, same reasoning as wallet.ts: these functions only run
// after a user clicks a deposit/withdraw/claim button, well past first paint.

import { Cl, Pc, type PostCondition } from "@stacks/transactions";
import { SHARE_TOKEN_NAME, TOKEN_CONTRACT_ID, VAULT_CONTRACT_ID } from "./config";
import { readWithdrawalRequest, type WithdrawalRequest } from "./reads";

export interface TxResult {
  txid?: string;
}

// deposit moves exactly `amount` uSTX from the depositor to the vault, then MINTS shares to
// the depositor (mints aren't post-condition-checked).
export async function depositStx(userAddress: string, amount: bigint): Promise<TxResult> {
  if (amount <= 0n) throw new Error("deposit amount must be > 0");
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: VAULT_CONTRACT_ID,
    functionName: "deposit",
    functionArgs: [Cl.uint(amount)],
    network: "mainnet",
    postConditions: [Pc.principal(userAddress).willSendEq(amount).ustx()],
    postConditionMode: "deny",
  });
}

// request-withdrawal moves exactly `shares` dsSTX from the depositor into the vault's custody
// (escrowed, not burned, until claim). No STX moves at request time.
export async function requestWithdrawal(userAddress: string, shares: bigint): Promise<TxResult> {
  if (shares <= 0n) throw new Error("share amount must be > 0");
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: VAULT_CONTRACT_ID,
    functionName: "request-withdrawal",
    functionArgs: [Cl.uint(shares)],
    network: "mainnet",
    postConditions: [Pc.principal(userAddress).willSendEq(shares).ft(TOKEN_CONTRACT_ID, SHARE_TOKEN_NAME)],
    postConditionMode: "deny",
  });
}

// claim-withdrawal moves two things, BOTH out of the vault contract: the locked STX payout
// (stx-transfer?) and the burn of the escrowed dsSTX (ft-burn? via burn-for-vault). Both must
// be declared or Deny mode aborts the claim. This shipped on 2026-10-05 with NO
// post-conditions, so every claim made through this UI would have aborted (found 2026-10-07;
// the only real claim so far went through the CLI in Allow mode). Both amounts are fixed at
// request time and can never change, so they're read fresh from the chain and declared exactly.
export function claimPostConditions(req: Pick<WithdrawalRequest, "lockedStx" | "shares">): PostCondition[] {
  return [
    Pc.principal(VAULT_CONTRACT_ID).willSendEq(req.lockedStx).ustx(),
    Pc.principal(VAULT_CONTRACT_ID).willSendEq(req.shares).ft(TOKEN_CONTRACT_ID, SHARE_TOKEN_NAME),
  ];
}

export async function claimWithdrawal(claimant: string, id: number): Promise<TxResult> {
  const req = await readWithdrawalRequest(id);
  if (!req) throw new Error(`withdrawal #${id} was not found on-chain`);
  if (req.owner !== claimant) throw new Error(`withdrawal #${id} belongs to a different address`);
  if (req.claimed) throw new Error(`withdrawal #${id} has already been claimed`);
  // A request that locked 0 uSTX can never be claimed (stx-transfer? of 0 fails), so don't
  // let a user pay a fee to find that out.
  if (req.lockedStx === 0n) throw new Error(`withdrawal #${id} locked 0 STX, so the contract can't pay it out`);
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: VAULT_CONTRACT_ID,
    functionName: "claim-withdrawal",
    functionArgs: [Cl.uint(id)],
    network: "mainnet",
    postConditions: claimPostConditions(req),
    postConditionMode: "deny",
  });
}
