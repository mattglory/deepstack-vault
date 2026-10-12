// Contract + network configuration for the v2 vault (deepstack-vault-v2.clar, see
// docs/VAULT_V2_DESIGN.md in the deepstack repo). No secrets: the app only ever signs with the
// CONNECTING USER's own wallet.
//
// Network and contract address are build-time settings, so one codebase serves the testnet dry
// run and, later, mainnet. Defaults point at the testnet deployment.

const ENV = import.meta.env;

export const NETWORK = ((ENV.VITE_STACKS_NETWORK as string | undefined) ?? "testnet") as "mainnet" | "testnet";
if (NETWORK !== "mainnet" && NETWORK !== "testnet") throw new Error(`bad VITE_STACKS_NETWORK: ${NETWORK}`);

export const VAULT_ADDRESS = (ENV.VITE_VAULT_ADDRESS as string | undefined) ?? "ST2ZBFNYZASTNQHSQSDV2NC04Y0513GVV5SHK3W5A";
export const VAULT_CONTRACT_NAME = "deepstack-vault-v2";
export const TOKEN_CONTRACT_NAME = "deepstack-vault-v2-token";
export const VAULT_CONTRACT_ID = `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}` as const;
export const TOKEN_CONTRACT_ID = `${VAULT_ADDRESS}.${TOKEN_CONTRACT_NAME}` as const;
export const SHARE_TOKEN_NAME = "deepstack-vault-v2-shares";

// network_id from /v2/info, checked before any signature is requested (see wallet.ts).
export const EXPECTED_NETWORK_ID = NETWORK === "mainnet" ? 1 : 2147483648;
export const HIRO_API_BASE = NETWORK === "mainnet" ? "https://api.mainnet.hiro.so" : "https://api.testnet.hiro.so";
export const EXPLORER_TX = (txid: string) => `https://explorer.hiro.so/txid/${txid}?chain=${NETWORK}`;
// Optional, and public in the bundle if set. Leave unset: visitors' own per-IP limits suffice.
export const HIRO_API_KEY = ENV.VITE_HIRO_API_KEY as string | undefined;

// Contract constants (deepstack-vault-v2.clar). All delays are BURN (Bitcoin) blocks.
export const MAX_EPOCH_BURN = 432;
export const TIMELOCK_BURN = 1008;
export const WITHDRAWAL_DELAY_BURN = 288;
export const VIRTUAL_ASSETS = 1n;      // uSTX
export const VIRTUAL_SHARES = 1000n;   // share units
export const PPS_SCALE = 10n ** 18n;
export const STX_DECIMALS = 6;
export const SHARE_DECIMALS = 9;
// Average seconds per burn block, only for human-readable ETAs. Bitcoin mainnet targets 600 s;
// testnet's burn chain ran at ~255 s when measured on 2026-10-12.
export const SEC_PER_BURN_BLOCK = NETWORK === "mainnet" ? 600 : 255;

export const READ_TIMEOUT_MS = 6_000;
export const REFRESH_MS = 60_000;
export const EPOCH_SCAN = 12; // how many recent epochs to scan for this user's queued items
