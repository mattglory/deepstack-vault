// Exact integer mirrors of deepstack-vault-v2.clar's pricing, so the UI shows precisely what the
// contract will do before a user signs, and refuses transactions it would reject. bigint only.

import { VIRTUAL_ASSETS, VIRTUAL_SHARES } from "./config";

// A = total-assets (uSTX), S = share supply (units, 9 decimals).
export const sharesForAssets = (amount: bigint, A: bigint, S: bigint) => (amount * (S + VIRTUAL_SHARES)) / (A + VIRTUAL_ASSETS);
export const assetsForShares = (shares: bigint, A: bigint, S: bigint) => (shares * (A + VIRTUAL_ASSETS)) / (S + VIRTUAL_SHARES);

// Parses a typed decimal into base units exactly ("1", "0.5", ".25"); null for anything else.
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  const m = new RegExp(`^(\\d*)(?:\\.(\\d{0,${decimals}}))?$`).exec(s);
  if (!m || !/\d/.test(s)) return null;
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

export function toInput(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const frac = (units % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / d}${frac ? `.${frac}` : ""}`;
}

// Display only (floats are never fed back into a transaction).
export function fmtUnits(units: bigint, decimals: number, dp: number): string {
  return (Number(units) / 10 ** decimals).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export const fmtStx = (u: bigint, dp = 2) => fmtUnits(u, 6, dp);
export const fmtShares = (u: bigint, dp = 4) => fmtUnits(u, 9, dp);
// pps is uSTX per share unit x 1e18; STX per whole share = pps / 1e15.
export const fmtPrice = (pps: bigint) => (Number(pps) / 1e15).toFixed(6);
