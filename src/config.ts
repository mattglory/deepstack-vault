// Contract + network configuration. No secrets live here or anywhere in this app. It only
// ever signs with the CONNECTING USER's own wallet, never an operator key.

export const VAULT_ADDRESS = "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60";
export const VAULT_CONTRACT_NAME = "deepstack-vault";
export const TOKEN_CONTRACT_NAME = "deepstack-vault-token";
export const VAULT_CONTRACT_ID = `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}` as const;
export const TOKEN_CONTRACT_ID = `${VAULT_ADDRESS}.${TOKEN_CONTRACT_NAME}` as const;
export const SHARE_TOKEN_NAME = "deepstack-vault-shares"; // the define-fungible-token name

export const NETWORK = "mainnet" as const;
// Mainnet's network_id from /v2/info, compared against the configured RPC's own reported
// value before any signature is requested (see wallet.ts). 1 = mainnet, 2147483648 = testnet.
export const EXPECTED_NETWORK_ID = 1;

export const HIRO_API_BASE = "https://api.mainnet.hiro.so";
// Set at build time (see .env.example). Raises the rate limit above the unauthenticated tier
// (50 requests/min and 20/s per IP). NOTE: any VITE_ variable is inlined into the public
// JavaScript bundle, so whatever key is set here is readable by anyone who opens the page.
export const HIRO_API_KEY = import.meta.env.VITE_HIRO_API_KEY as string | undefined;

// Compile-time Clarity constants (contracts/deepstack-vault.clar). NOT readable via a
// contract call, since they're constants, not data-vars. Must be kept in sync with the
// deployed contract by hand; confirmed against the live deploy on 2026-10-05.
export const WITHDRAWAL_DELAY_BLOCKS = 11_330;
export const TIMELOCK_DELAY_BLOCKS = 39_660; // admin params only
export const MIN_FIRST_DEPOSIT = 1_000_000n; // uSTX, only applies while share supply is zero
// Share-pricing offsets (VIRTUAL-SHARES / VIRTUAL-ASSETS). Mirrored here only so the UI can
// show EXACTLY what assets-for-shares / shares-for-deposit would return before the user
// signs (see math.ts).
export const VIRTUAL_SHARES = 1_000_000n;
export const VIRTUAL_ASSETS = 1_000_000n;

// The contract's block counts were sized assuming ~15.25 s/block. Mainnet ran faster:
// withdrawal #0 was requested at block 9,126,363 (2026-10-05 10:21:41 UTC) and became
// claimable at block 9,137,693 (2026-10-07 04:28:45 UTC), i.e. 11,330 blocks in 42h07m =
// 13.38 s/block. So every block-count delay is shorter in real time than the "2 days" /
// "7 days" it was meant to represent. Durations shown to users are therefore always
// computed from a LIVE measurement (reads.ts measureSecPerBlock); this figure is only the
// fallback until that measurement first succeeds.
export const FALLBACK_SEC_PER_BLOCK = 13.38;

// Any single API request still unanswered after this long is aborted and retried. Hiro's
// intermittent "503 upstream connect error" responses took up to ~10s to arrive (2026-10-07).
export const READ_TIMEOUT_MS = 6_000;
export const LIVE_REFRESH_MS = 60_000; // balances, pause flags, P&L, block height
export const SETTINGS_REFRESH_MS = 5 * 60_000; // timelocked params + queued changes (6+ days notice)
export const PACE_REFRESH_MS = 60 * 60_000; // block-pace measurement

export const MICROSTX_PER_STX = 1_000_000;
