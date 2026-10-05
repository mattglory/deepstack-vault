// Every broadcast here is signed by the CONNECTED USER's own wallet via @stacks/connect's
// request('stx_callContract', ...) — this app never holds or touches a private key.
//
// Post-conditions: exact-amount (`willSendEq`), Deny mode, on every call that moves the
// user's own STX or dsSTX. Deny mode means the transaction aborts on-chain if the contract
// tries to move anything other than exactly what's declared here — see
// reports/DeepStack vault deposit frontend.md for why this is the tightest available
// protection for a fixed, known amount (vs. willSendGte/Lte, meant for variable/slippage
// amounts this flow doesn't have).
//
// `request` is dynamically imported here, same reasoning as wallet.ts — these functions only
// ever run after a user has already clicked a deposit/withdraw/claim button, well past the
// point where the WalletConnect/Reown AppKit bundle's size matters for first paint.

import { Cl, Pc } from "@stacks/transactions";
import { TOKEN_CONTRACT_ID, VAULT_ADDRESS, VAULT_CONTRACT_NAME, MICROSTX_PER_STX } from "./config";

export interface TxResult {
  txid?: string;
}

export async function depositStx(userAddress: string, amountStx: number): Promise<TxResult> {
  const amountMicroStx = Math.round(amountStx * MICROSTX_PER_STX);
  if (!(amountMicroStx > 0)) throw new Error("deposit amount must be > 0");
  const postCondition = Pc.principal(userAddress).willSendEq(amountMicroStx).ustx();
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}`,
    functionName: "deposit",
    functionArgs: [Cl.uint(amountMicroStx)],
    network: "mainnet",
    postConditions: [postCondition],
    postConditionMode: "deny",
  });
}

export async function requestWithdrawal(userAddress: string, shares: number): Promise<TxResult> {
  const sharesBase = Math.round(shares * MICROSTX_PER_STX);
  if (!(sharesBase > 0)) throw new Error("share amount must be > 0");
  // The shares being requested move from the depositor to the vault's own custody (escrowed,
  // not burned, until claim) — the post-condition is on the dsSTX fungible token, not STX.
  const postCondition = Pc.principal(userAddress).willSendEq(sharesBase).ft(TOKEN_CONTRACT_ID, "deepstack-vault-shares");
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}`,
    functionName: "request-withdrawal",
    functionArgs: [Cl.uint(sharesBase)],
    network: "mainnet",
    postConditions: [postCondition],
    postConditionMode: "deny",
  });
}

export async function claimWithdrawal(id: number): Promise<TxResult> {
  // No outbound post-condition from the claimant here -- the vault is the one sending STX
  // (a post-condition only constrains what the SIGNER's own principal sends, see
  // reports/DeepStack vault deposit frontend.md). The claimed amount was already locked and
  // disclosed to the user at request time (readWithdrawalRequest), not something this call
  // can change, so there is nothing of the signer's own to constrain here.
  const { request } = await import("@stacks/connect");
  return request("stx_callContract", {
    contract: `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}`,
    functionName: "claim-withdrawal",
    functionArgs: [Cl.uint(id)],
    network: "mainnet",
    postConditionMode: "deny",
  });
}
