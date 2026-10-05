# DeepStack vault app

Third-party deposit frontend for [DeepStack](https://github.com/mattglory/deepstack)'s
`deepstack-vault.clar` contract on Stacks mainnet. Lets a visitor connect their own wallet
(Leather, Xverse, or any SIP-030-compatible wallet) and deposit, request a withdrawal, and
claim a withdrawal — directly against the contract, no backend involved.

**Status: not yet open to the public.** The contract itself is live and seeded with the
operator's own capital only. This app is built so it's ready; opening it to real third-party
deposits is a separate decision gated on a professional third-party audit and a lawyer
consultation on the consent-gate wording — see
[`reports/DeepStack vault deposit frontend.md`](https://github.com/mattglory/deepstack/blob/main/reports/DeepStack%20vault%20deposit%20frontend.md)
in the main repo for the full reasoning behind every choice in this app.

## Why a separate repo

This app shares no secrets, no build pipeline, and no dependencies with DeepStack's admin
CLI/VPS tooling. A compromised dependency here can at worst trick a connecting visitor's own
wallet into signing something unintended for that one visitor — it cannot reach anything the
operator controls, because nothing operator-controlled is ever present in this codebase.

## Architecture

- Vite + vanilla TypeScript, no UI framework — the signing flow genuinely needs a bundler
  (neither Hiro's `@stacks/connect` nor Xverse's `sats-connect` document a CDN script-tag
  path), but nothing here needs component state management on top of that.
- `@stacks/connect`'s current `request()` API (not the older `doContractCall`/`showConnect`
  pattern still floating around outdated tutorials).
- All on-chain state reads happen directly from the browser via `fetchCallReadOnlyFunction`
  — no backend, no database.
- `@stacks/connect` is **dynamically imported**, not a static top-level import — it bundles
  the full WalletConnect/Reown AppKit SDK (~550KB minified, for QR-code mobile wallet
  support), and a visitor who only wants to read public vault stats shouldn't pay that
  download cost before ever clicking "Connect wallet."

## Known limitations (disclosed, not hidden)

- **Withdrawal tracking is per-browser, not a real index.** The vault contract has no
  "withdrawal ids belonging to address X" lookup — `next-withdrawal-id` is a single global
  counter. This app remembers ids it witnessed being created, in `localStorage`. Clear your
  browser data or switch devices and that history is gone locally — use the manual
  "check a withdrawal by id" lookup (the id itself is public on-chain) to recover it.
- **The high-water-mark chart is a local, best-effort history**, not a real time series
  pulled from an indexer — the contract only exposes *current* cumulative P&L / HWM values,
  not historical ones. The chart is built from this one browser's own visits over time. The
  live numbers shown alongside it are always the authoritative, current on-chain values.
- **The fee is vault-wide, not per-depositor.** DeepStack's performance fee is charged on the
  vault's cumulative realized P&L as a whole, above its own all-time high, diluting all
  shares pro-rata when it fires — there's no separate fee event triggered by an individual
  withdrawal. The "Your position" panel shows your share's current value, which already
  reflects any past fee dilution.

## Development

```bash
npm install
cp .env.example .env.local   # optional: add a free Hiro API key
npm run dev
```

```bash
npm run typecheck   # tsc --noEmit
npm run build        # typecheck + production build to dist/
```

## Known npm audit findings

`npm audit` currently reports vulnerabilities (moderate/high) inherited transitively through
`@stacks/connect`'s bundled WalletConnect/Reown AppKit dependency tree (`elliptic`,
`decode-uri-component`, `bip322-js`, and their dependents) — these are in the
QR-code/mobile-wallet-connect code path, not the primary browser-extension (Leather/Xverse)
flow this app's own code calls. `npm audit fix --force` would downgrade `@stacks/connect` to
an older, unresearched API version to resolve them, which trades a real but narrow upstream
risk for a worse one (shipping against an unverified API surface). Tracked via Dependabot
instead, to pick this up automatically once `@stacks/connect` ships a fix upstream.
