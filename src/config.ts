// Contract + network configuration. No secrets live here or anywhere in this app — it only
// ever signs with the CONNECTING USER's own wallet, never an operator key.

export const VAULT_ADDRESS = "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60";
export const VAULT_CONTRACT_NAME = "deepstack-vault";
export const TOKEN_CONTRACT_NAME = "deepstack-vault-token";
export const VAULT_CONTRACT_ID = `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}` as const;
export const TOKEN_CONTRACT_ID = `${VAULT_ADDRESS}.${TOKEN_CONTRACT_NAME}` as const;

export const NETWORK = "mainnet" as const;
// Mainnet's network_id from /v2/info — compared against the configured RPC's own reported
// value before any signature is requested (see wallet.ts). 1 = mainnet, 2147483648 = testnet.
export const EXPECTED_NETWORK_ID = 1;

export const HIRO_API_BASE = "https://api.mainnet.hiro.so";
// Set at build time (see .env.example) — raises the read-only call rate limit well above the
// unauthenticated tier. The app still functions without one, just more likely to hit a limit
// under load.
export const HIRO_API_KEY = import.meta.env.VITE_HIRO_API_KEY as string | undefined;

// Compile-time Clarity constants (contracts/deepstack-vault.clar) — NOT readable via a
// contract call, since they're constants, not data-vars. Must be kept in sync with the
// deployed contract by hand; see docs/VAULT_MAINNET_DEPLOY.md's verification step for how
// these were confirmed against the live deploy on 2026-10-05.
export const WITHDRAWAL_DELAY_BLOCKS = 11_330; // ~2 days at ~15.25 sec/block
export const TIMELOCK_DELAY_BLOCKS = 39_660; // ~7 days at ~15.25 sec/block (admin params only)
// Same assumption the contract's own deploy-time comment uses — an estimate, not a guarantee;
// real cadence drifts. Used only to turn a block count into a human-readable ETA.
export const ASSUMED_SEC_PER_BLOCK = 15.25;

export const MICROSTX_PER_STX = 1_000_000;
