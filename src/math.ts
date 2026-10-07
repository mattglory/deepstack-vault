// Exact integer mirrors of the vault contract's share pricing (contracts/deepstack-vault.clar),
// so the UI can show precisely what the contract will do BEFORE a user signs, and refuse to
// build a transaction the contract is certain to reject. All amounts are base units
// (uSTX / dsSTX, 6 decimals) as bigint. Never floating point.

import { VIRTUAL_ASSETS, VIRTUAL_SHARES } from "./config";

export const MICRO = 1_000_000n;

// assets-for-shares: floor(shares * (total-assets + VIRTUAL-ASSETS) / (supply + VIRTUAL-SHARES)).
// This is the uSTX a withdrawal request for `shares` would lock right now.
export function assetsForShares(shares: bigint, totalAssets: bigint, supply: bigint): bigint {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (supply + VIRTUAL_SHARES);
}

// shares-for-deposit: floor(amount * (supply + VIRTUAL-SHARES) / (total-assets + VIRTUAL-ASSETS)).
export function sharesForDeposit(amount: bigint, totalAssets: bigint, supply: bigint): bigint {
  return (amount * (supply + VIRTUAL_SHARES)) / (totalAssets + VIRTUAL_ASSETS);
}

// Largest share amount whose assetsForShares still fits within `freeBalance`. The contract
// rejects a request (ERR-INSUFFICIENT-LIQUIDITY, u107) when the locked amount exceeds it.
//   max s with floor(s*A/S) <= F  <=>  s*A < (F+1)*S  <=>  s <= ((F+1)*S - 1) / A
export function maxSharesWithinLiquidity(freeBalance: bigint, totalAssets: bigint, supply: bigint): bigint {
  const A = totalAssets + VIRTUAL_ASSETS;
  const S = supply + VIRTUAL_SHARES;
  return ((freeBalance + 1n) * S - 1n) / A;
}

// Parses a typed decimal amount ("1", "0.5", ".25", "12.345678") into base units exactly.
// Returns null for anything else: negative, more than 6 decimals, exponent notation, empty.
export function parseAmount(input: string): bigint | null {
  const s = input.trim();
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m || !/\d/.test(s)) return null;
  return BigInt(m[1] || "0") * MICRO + BigInt((m[2] ?? "").padEnd(6, "0"));
}

// Display only. Converting to a float is safe here (never fed back into a transaction).
export const microToNumber = (m: bigint): number => Number(m) / 1e6;

export function fmtStx(m: bigint, dp = 2): string {
  return microToNumber(m).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// Exact decimal string for an input field's value/max attribute (no float rounding).
export function microToInput(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const frac = (a % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / MICRO}${frac ? `.${frac}` : ""}`;
}
