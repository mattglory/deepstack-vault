// Wallet connection + network safety check. Never touches a private key — every signature
// comes from the connecting user's own wallet extension via @stacks/connect's `request()`.
//
// @stacks/connect is dynamically imported (not a static top-level import) because it bundles
// the full WalletConnect/Reown AppKit SDK (~550KB minified) for QR-code mobile wallet support
// — a visitor who only wants to read public vault stats shouldn't pay that download/parse cost
// before ever clicking "Connect wallet". writes.ts does the same for the same reason.

import { EXPECTED_NETWORK_ID } from "./config";
import { readNetworkId } from "./reads";

export function getConnectedAddress(): string | null {
  // getLocalStorage() only reads from localStorage, no network/wallet calls, so it's safe to
  // load eagerly without pulling in the full connect bundle at module scope — still deferred
  // to keep this file free of the static import entirely.
  try {
    const raw = localStorage.getItem("@stacks/connect");
    if (!raw) return null;
    const data = JSON.parse(raw) as { addresses?: { stx?: { address?: string }[] } };
    return data.addresses?.stx?.[0]?.address ?? null;
  } catch {
    return null;
  }
}

export async function connectWallet(): Promise<string> {
  const { connect, getLocalStorage } = await import("@stacks/connect");
  const result = await connect();
  const stxAddr = result.addresses.find((a) => a.symbol === "STX")?.address ?? getLocalStorage()?.addresses.stx?.[0]?.address ?? null;
  if (!stxAddr) throw new Error("wallet did not return a Stacks address");
  return stxAddr;
}

export async function disconnectWallet(): Promise<void> {
  const { disconnect } = await import("@stacks/connect");
  disconnect();
}

// @stacks/connect has historically not reliably exposed which network the connected wallet
// extension itself is set to (no stx_getNetworks support in every wallet) — see
// reports/DeepStack vault deposit frontend.md. The safe pattern is independently checking the
// API endpoint's own reported network_id and refusing to proceed on a mismatch, rather than
// trusting the wallet to self-report before a signature is requested.
export async function verifyMainnet(): Promise<{ ok: boolean; networkId: number }> {
  const networkId = await readNetworkId();
  return { ok: networkId === EXPECTED_NETWORK_ID, networkId };
}
