import "./style.css";
import {
  NETWORK, VAULT_CONTRACT_ID, MAX_EPOCH_BURN, TIMELOCK_BURN, WITHDRAWAL_DELAY_BURN, SEC_PER_BURN_BLOCK,
  REFRESH_MS, EPOCH_SCAN, EXPECTED_NETWORK_ID, EXPLORER_TX, STX_DECIMALS, SHARE_DECIMALS,
} from "./config";
import {
  readState, readPendingChanges, readShareBalance, readRequest, readEpoch, readEpochDeposit, readEpochWithdrawal,
  readChainInfo, type VaultState, type PendingChange, type IdleRequest, type Epoch,
} from "./reads";
import { connectWallet, disconnectWallet, getConnectedAddress, addressMatchesNetwork } from "./wallet";
import {
  deposit, requestWithdrawal, claimIdle, claimEpochDeposit, claimEpochWithdrawal, cancelDeposit, cancelWithdrawal,
  settleOverdue, type TxResult,
} from "./writes";
import { waitForTx, parseRequestRepr } from "./tx";
import { rememberRequest, forgetRequest, rememberEpoch, knownRequests, knownEpochs } from "./known-withdrawals";
import { sharesForAssets, assetsForShares, parseUnits, toInput, fmtStx, fmtShares, fmtPrice } from "./math";

// ---------------------------------------------------------------------------
// State. A value is only replaced by a successful read; a failed read keeps the last good value
// and marks it stale. Never-read values are undefined and render as "unavailable", never as 0.
// ---------------------------------------------------------------------------

let address: string | null = getConnectedAddress();
let networkOk: boolean | null = null; // the API's network_id matches this build
let vs: VaultState | undefined;
let currentEpoch: Epoch | null | undefined; // the open epoch's record, null when idle
let pending: PendingChange[] | undefined;
let burnHeight: bigint | undefined;
let shareBalance: bigint | undefined;
let requests: IdleRequest[] = [];
interface EpochItem { e: bigint; ep: Epoch; dep: bigint; wd: bigint }
let epochItems: EpochItem[] = [];
const stale = new Set<string>();
let lastRefreshAt: number | null = null;

// Settled epochs never change, and a settled epoch in which this user has nothing can never gain
// anything (nobody can queue into a settled epoch). Both are cached so the per-refresh scan only
// re-reads what can still move. Keyed by address for the empty set.
const settledEpochCache = new Map<string, Epoch>();
const emptySettled = new Set<string>();

let lookupResult: IdleRequest | "not-found" | "error" | null = null;
let busy = false;
let draftDeposit = "";
let draftWithdraw = "";
let draftLookup = "";

const consent = { strategy: false, audit: false, timing: false, fee: false, testnet: false, jurisdiction: false };
const consentAllChecked = () => Object.values(consent).every(Boolean);

type StatusKind = "info" | "success" | "error";
let status: { html: string; kind: StatusKind; loadError: boolean } | null = null;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function setStatus(message: string, kind: StatusKind, loadError = false, txid?: string): void {
  const link = txid ? ` <a href="${EXPLORER_TX(txid)}" target="_blank" rel="noopener">view transaction</a>` : "";
  status = { html: escapeHtml(message) + link, kind, loadError };
  renderStatusBanner();
}
function clearStatus(): void {
  status = null;
  renderStatusBanner();
}
function renderStatusBanner(): void {
  const el = document.getElementById("status-banner");
  if (!el) return;
  if (!status) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.className = `status-banner ${status.kind}`;
  el.innerHTML = `<span>${status.html}</span><button class="secondary" id="btn-dismiss-status">Dismiss</button>`;
  document.getElementById("btn-dismiss-status")!.addEventListener("click", clearStatus);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const yesNo = (b: boolean) => (b ? "yes" : "no");
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(1)}%`;
const stx = (u: bigint, dp = 6) => `${fmtStx(u, dp)} STX`;

// Delays are enforced in Bitcoin (burn) blocks. Times are a rough guide only.
function burnToDuration(blocks: bigint | number): string {
  const secs = Number(blocks) * SEC_PER_BURN_BLOCK;
  if (secs >= 86_400) return `about ${(secs / 86_400).toFixed(1)} days`;
  if (secs >= 3_600) return `about ${(secs / 3_600).toFixed(1)} hours`;
  return `about ${Math.max(1, Math.round(secs / 60))} minutes`;
}
const blocksText = (n: number) => `${n.toLocaleString()} Bitcoin blocks, ${burnToDuration(n)}`;

const UNAVAILABLE = `<span class="unavailable">unavailable</span>`;
const STALE_TITLE = "Couldn't refresh this just now. Showing the last good reading.";
function show<T>(value: T | undefined, key: string, format: (v: T) => string): string {
  if (value === undefined) return UNAVAILABLE;
  return stale.has(key) ? `<span class="stale" title="${STALE_TITLE}">${format(value)}</span>` : format(value);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function epochCached(e: bigint): Promise<Epoch | null> {
  const k = e.toString();
  const hit = settledEpochCache.get(k);
  if (hit) return hit;
  const ep = await readEpoch(e);
  if (ep?.settled) settledEpochCache.set(k, ep);
  return ep;
}

// The contract has no per-user index, so scan the most recent epochs plus any this browser saw
// the user queue into. Throws if any read fails, so the caller keeps the previous list.
async function scanEpochs(who: string, cur: bigint): Promise<EpochItem[]> {
  const ids = new Set<bigint>(knownEpochs(who));
  for (let e = cur; e >= 0n && e > cur - BigInt(EPOCH_SCAN); e--) ids.add(e);
  const out: EpochItem[] = [];
  await Promise.all(
    [...ids].map(async (e) => {
      const ek = `${who}:${e}`;
      if (emptySettled.has(ek)) return;
      const [dep, wd] = await Promise.all([readEpochDeposit(e, who), readEpochWithdrawal(e, who)]);
      if (dep === 0n && wd === 0n) {
        // Every epoch below the current id has settled (the id only advances on settlement).
        if (e < cur) emptySettled.add(ek);
        return;
      }
      const ep = await epochCached(e);
      if (ep) out.push({ e, ep, dep, wd });
    }),
  );
  return out.sort((a, b) => (a.e < b.e ? 1 : -1));
}

async function readKnownRequests(who: string): Promise<IdleRequest[]> {
  const ids = knownRequests(who);
  const results = await Promise.allSettled(ids.map((id) => readRequest(id)));
  return ids.flatMap((id, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      if (!r.value) forgetRequest(who, id); // claimed: the contract deletes the record
      return r.value && r.value.owner === who ? [r.value] : [];
    }
    const prev = requests.find((w) => w.id === id);
    return prev ? [prev] : [];
  });
}

async function doRefresh(): Promise<void> {
  const who = address; // a disconnect mid-refresh must not write this user's data back
  const [stateR, pendingR, chainR] = await Promise.allSettled([readState(), readPendingChanges(), readChainInfo()]);

  if (stateR.status === "fulfilled") {
    vs = stateR.value;
    stale.delete("state");
  } else stale.add("state");
  if (pendingR.status === "fulfilled") {
    pending = pendingR.value;
    stale.delete("pending");
  } else stale.add("pending");
  if (chainR.status === "fulfilled") {
    burnHeight = chainR.value.burnHeight;
    networkOk = chainR.value.networkId === EXPECTED_NETWORK_ID;
    stale.delete("chain");
  } else stale.add("chain");

  const [epR, balR, reqR, scanR] = await Promise.allSettled([
    vs?.epochOpen ? readEpoch(vs.currentEpoch) : Promise.resolve(null),
    who ? readShareBalance(who) : Promise.resolve(undefined),
    who ? readKnownRequests(who) : Promise.resolve([] as IdleRequest[]),
    who && vs ? scanEpochs(who, vs.currentEpoch) : Promise.resolve(undefined),
  ]);
  if (epR.status === "fulfilled") currentEpoch = epR.value;
  if (who !== null && who === address) {
    if (balR.status === "fulfilled" && balR.value !== undefined) {
      shareBalance = balR.value;
      stale.delete("user.shares");
    } else if (balR.status === "rejected") stale.add("user.shares");
    if (reqR.status === "fulfilled") requests = reqR.value;
    if (scanR.status === "fulfilled" && scanR.value !== undefined) {
      epochItems = scanR.value;
      stale.delete("user.epochs");
    } else if (scanR.status === "rejected") stale.add("user.epochs");
  }

  lastRefreshAt = Date.now();
  if (vs === undefined) setStatus("Couldn't reach the Stacks API to load vault data. This happens intermittently. Retrying automatically.", "error", true);
  else if (status?.loadError) clearStatus();
  renderAll();
}

let refreshInFlight: Promise<void> | null = null;
let rerunRequested = false;
function refreshAll(): Promise<void> {
  if (refreshInFlight) {
    rerunRequested = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    do {
      rerunRequested = false;
      try {
        await doRefresh();
      } catch (err) {
        console.error("refresh failed", err);
      }
    } while (rerunRequested);
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const walletOk = () => address !== null && networkOk !== false && addressMatchesNetwork(address);

function renderWalletArea(): void {
  const el = document.getElementById("wallet-area")!;
  if (!address) {
    el.innerHTML = `<button id="btn-connect">Connect wallet</button>`;
    document.getElementById("btn-connect")!.addEventListener("click", onConnect);
    return;
  }
  const badge = !addressMatchesNetwork(address) || networkOk === false ? `<span class="badge bad">wrong network</span>` : `<span class="badge ok">${NETWORK}</span>`;
  el.innerHTML = `<span class="muted">${shortAddr(address)}</span> ${badge} <button class="secondary" id="btn-disconnect">Disconnect</button>`;
  document.getElementById("btn-disconnect")!.addEventListener("click", onDisconnect);
}

function resetUserState(): void {
  shareBalance = undefined;
  requests = [];
  epochItems = [];
  stale.delete("user.shares");
  stale.delete("user.epochs");
  lookupResult = null;
}

async function onConnect(): Promise<void> {
  try {
    address = await connectWallet();
  } catch (err) {
    setStatus(`Connect failed: ${(err as Error).message}`, "error");
    return;
  }
  resetUserState();
  await refreshAll();
}

async function onDisconnect(): Promise<void> {
  await disconnectWallet();
  address = null;
  resetUserState();
  renderAll();
}

function renderNetworkBanner(): void {
  const el = document.getElementById("network-banner")!;
  if (NETWORK === "testnet") {
    el.hidden = false;
    el.textContent = "Testnet build. Testnet STX has no value. This page talks to the testnet deployment of vault v2 only.";
  } else el.hidden = true;
}

// ---------------------------------------------------------------------------
// Vault status (public)
// ---------------------------------------------------------------------------

function phaseHtml(s: VaultState): string {
  if (!s.initialized) return `<span class="phase">not initialized yet</span>`;
  if (!s.epochOpen) return `<span class="phase idle">IDLE</span>`;
  return `<span class="phase deployed">DEPLOYED, epoch ${s.currentEpoch}</span>`;
}

function epochDeadlineHtml(s: VaultState): string {
  if (!s.epochOpen || !currentEpoch) return "";
  const due = currentEpoch.startBurn + BigInt(MAX_EPOCH_BURN);
  const left = burnHeight !== undefined ? due - burnHeight : undefined;
  const when = s.overdue
    ? `<span class="notice bad">overdue now</span>`
    : left !== undefined && left > 0n
      ? `Bitcoin block ${due.toLocaleString()}, in ${burnToDuration(left)}`
      : `Bitcoin block ${due.toLocaleString()}`;
  return `
    <div class="stat-row"><span class="label">Deployed this epoch</span><span>${stx(currentEpoch.deployed, 2)}</span></div>
    <div class="stat-row"><span class="label">Must return by</span><span>${when}</span></div>`;
}

function renderVaultStats(): void {
  const el = document.getElementById("vault-stats-body")!;
  document.getElementById("vault-addr-footer")!.textContent = VAULT_CONTRACT_ID;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const s = vs;
  if (!s) {
    el.innerHTML = `<p class="notice bad">Vault data unavailable. Retrying automatically.</p>`;
    return;
  }
  const k = "state";
  const committed = s.totalAssets + s.pendingDeposits;
  const fillPct = s.maxTvl > 0n ? Math.min(100, (Number(committed) / Number(s.maxTvl)) * 100) : 0;
  const floor = (s.sweepRefPps * 9n) / 10n;
  const overdueBtn = s.epochOpen && s.overdue
    ? `<p class="notice bad">This epoch passed its ${MAX_EPOCH_BURN}-block deadline without the strategy returning capital. Anyone can now settle it as a write-off: queued deposits become 1:1 refunds and queued withdrawals get their shares back.</p>
       <button class="secondary" id="btn-settle-overdue" ${walletOk() && !busy ? "" : "disabled"}>Settle overdue epoch</button>`
    : "";
  el.innerHTML = `
    <div class="stat-row"><span class="label">Phase</span><span>${show(s, k, phaseHtml)}</span></div>
    ${epochDeadlineHtml(s)}
    <div class="stat-row"><span class="label">Pilot cap (includes queued deposits)</span><span>${show(s, k, () => `${fmtStx(committed, 2)} / ${fmtStx(s.maxTvl, 0)} STX`)}</span></div>
    <div class="cap-bar"><div class="cap-bar-fill ${committed >= s.maxTvl ? "full" : ""}" style="width:${fillPct}%"></div></div>
    <div class="stat-row"><span class="label">Share price</span><span>${show(s, k, () => `${fmtPrice(s.pps)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Fee high-water mark</span><span>${show(s, k, () => `${fmtPrice(s.hwmPps)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Sweeps blocked below</span><span>${show(s, k, () => `${fmtPrice(floor)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Vault assets</span><span>${show(s, k, () => stx(s.totalAssets, 2))}</span></div>
    <div class="stat-row"><span class="label">At the strategy now</span><span>${show(s, k, () => stx(s.capitalAtStrategy, 2))}</span></div>
    <div class="stat-row"><span class="label">Queued deposits / reserved for claims</span><span>${show(s, k, () => `${fmtStx(s.pendingDeposits, 2)} / ${fmtStx(s.ringfenced, 2)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Realized P&amp;L, all epochs</span><span>${show(s, k, () => stx(s.realizedPnl, 6))}</span></div>
    <div class="stat-row"><span class="label">Performance fee</span><span>${show(s, k, () => pct(s.feeBps))}</span></div>
    <div class="stat-row"><span class="label">Most the admin can sweep</span><span>${show(s, k, () => `${pct(s.maxDeployBps)} of vault assets`)}</span></div>
    <div class="stat-row"><span class="label">Deposits paused / sweeps paused</span><span>${show(s, k, () => `${yesNo(s.depositsPaused)} / ${yesNo(s.sweepsPaused)}`)}</span></div>
    <div class="stat-row"><span class="label">Admin</span><span>${show(s, k, () => shortAddr(s.admin))}</span></div>
    <div class="stat-row"><span class="label">Strategy</span><span>${show(s, k, () => shortAddr(s.strategy))}</span></div>
    <div class="stat-row"><span class="label">Guardian (pause only)</span><span>${show(s, k, () => shortAddr(s.guardian))}</span></div>
    <div class="stat-row"><span class="label">Idle withdrawal delay</span><span>${blocksText(WITHDRAWAL_DELAY_BURN)}</span></div>
    <div class="stat-row"><span class="label">Longest an epoch can run</span><span>${blocksText(MAX_EPOCH_BURN)}</span></div>
    <div class="stat-row"><span class="label">Notice before an admin change</span><span>${blocksText(TIMELOCK_BURN)}</span></div>
    ${overdueBtn}
    <p class="updated">Times are approximate (about ${Math.round(SEC_PER_BURN_BLOCK / 60)} minutes per Bitcoin block on ${NETWORK}). ${lastRefreshAt ? `Updated ${new Date(lastRefreshAt).toLocaleTimeString()}.` : ""}${stale.size ? " Some values couldn't be refreshed and show the last good reading, underlined." : ""}</p>
  `;
  document.getElementById("btn-settle-overdue")?.addEventListener("click", () =>
    runTx("Settling the overdue epoch", () => settleOverdue(), () => "Overdue epoch settled."),
  );
}

// ---------------------------------------------------------------------------
// Queued admin changes (public)
// ---------------------------------------------------------------------------

const PARAM_LABELS: Record<string, string> = {
  "max-tvl": "Deposit cap", "fee-bps": "Performance fee", "max-deploy-bps": "Sweep cap", "fee-recipient": "Fee recipient",
  strategy: "Strategy address", guardian: "Guardian", admin: "Admin", "resume-sweeps": "Resume sweeps after a drawdown block",
};
function formatParam(p: PendingChange): string {
  if (p.value === null) return "";
  if (typeof p.value === "string") return shortAddr(p.value);
  if (p.param === "max-tvl") return stx(p.value, 0);
  return pct(p.value);
}

function renderPendingPanel(): void {
  const el = document.getElementById("pending-body")!;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const rules = `Every admin change must wait here in public for ${blocksText(TIMELOCK_BURN)}, before it can take effect. No new sweep can start while any change is waiting, and an epoch lasts at most ${MAX_EPOCH_BURN} blocks, so depositors have time to exit first.`;
  if (pending === undefined) {
    el.innerHTML = `<p class="notice bad">Couldn't check for queued changes just now. Retrying automatically.</p><p class="notice">${rules}</p>`;
    return;
  }
  if (pending.length === 0) {
    el.innerHTML = `<p>None queued.</p><p class="notice">${rules}</p>`;
    return;
  }
  const cards = pending
    .map((p) => {
      const left = burnHeight !== undefined ? p.executableAt - burnHeight : undefined;
      const when = left === undefined
        ? `Can take effect from Bitcoin block ${p.executableAt.toLocaleString()}.`
        : left <= 0n
          ? "Can take effect now."
          : `Can take effect from Bitcoin block ${p.executableAt.toLocaleString()}, in ${burnToDuration(left)}.`;
      const v = formatParam(p);
      return `<div class="pending-card">
        <div class="stat-row"><span class="label">${PARAM_LABELS[p.param] ?? escapeHtml(p.param)}</span><span>${v ? `to ${v}` : "queued"}</span></div>
        <p class="notice">${when}</p></div>`;
    })
    .join("");
  el.innerHTML = cards + (stale.has("pending") ? `<p class="notice bad">This list may be out of date.</p>` : "") + `<p class="notice">${rules}</p>`;
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

const CONSENT_ITEMS: { key: keyof typeof consent; label: string }[] = [
  {
    key: "strategy",
    label:
      "When the admin sweeps capital to the strategy (at most the sweep cap shown above), the contract cannot verify what happens to it until it comes back. The strategy reports the result by returning STX. If it does not return within the epoch deadline, anyone can write the epoch off, and the vault then carries that capital at zero until any late recovery.",
  },
  {
    key: "audit",
    label: "The v2 contracts have had an independent design and code review and an automated test suite. They have NOT had a professional third-party security audit.",
  },
  {
    key: "timing",
    label:
      "While the vault is IDLE, a withdrawal is priced when I request it and claimable after the idle delay. While it is DEPLOYED, my deposit or withdrawal is queued and priced only when the epoch settles, so the price I get can differ from the price I see now. I can cancel a queued item until then.",
  },
  {
    key: "fee",
    label: "A performance fee is taken only when an epoch settles with the share price above its previous high-water mark, and only on the gain above it. It is paid in new shares, never from deposits.",
  },
  {
    key: "testnet",
    label: NETWORK === "testnet"
      ? "This is the testnet deployment. Testnet STX has no value and this deployment may be reset."
      : "This vault is in a capped pilot phase. The cap is raised only after a published review.",
  },
  {
    key: "jurisdiction",
    label: "I am not a resident of, and am not accessing this from, a jurisdiction where interacting with this contract would be unlawful, and I am acting on my own behalf.",
  },
];

function renderConsentGate(): void {
  const el = document.getElementById("consent-body")!;
  el.innerHTML =
    CONSENT_ITEMS.map(
      (item) => `
      <label class="consent-item">
        <input type="checkbox" data-consent="${item.key}" ${consent[item.key] ? "checked" : ""} />
        <span>${item.label}</span>
      </label>`,
    ).join("") +
    `<p class="notice">This is not an investment and not a promise of profit. This page lets you deposit STX into a published Clarity vault contract. Design and terms: <a href="https://github.com/mattglory/deepstack/blob/main/docs/VAULT_V2_DESIGN.md" target="_blank" rel="noopener">VAULT_V2_DESIGN.md</a>.</p>`;
  el.querySelectorAll<HTMLInputElement>("input[data-consent]").forEach((input) => {
    input.addEventListener("change", () => {
      consent[input.dataset.consent as keyof typeof consent] = input.checked;
      renderDepositPanel();
    });
  });
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

function depositHeadroom(s: VaultState): bigint {
  const used = s.totalAssets + s.pendingDeposits;
  return s.maxTvl > used ? s.maxTvl - used : 0n;
}

function wrongNetworkNotice(): string | null {
  if (!address) return null;
  if (!addressMatchesNetwork(address)) return `Your wallet is on the wrong network. Switch it to ${NETWORK}, then reconnect.`;
  if (networkOk === false) return `The API answering this page is not on ${NETWORK}, so signing is disabled.`;
  return null;
}

function renderDepositPanel(): void {
  const el = document.getElementById("deposit-body")!;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const s = vs;
  const headroom = s ? depositHeadroom(s) : 0n;
  let notice = "";
  let bad = true;
  if (!address) [notice, bad] = ["Connect your wallet to deposit.", false];
  else if (wrongNetworkNotice()) notice = wrongNetworkNotice()!;
  else if (!s) notice = "Can't load the vault's state right now, so deposits stay disabled until it loads.";
  else if (!s.initialized) notice = "The vault has not been initialized yet.";
  else if (s.depositsPaused) notice = "Deposits are paused. Withdrawals, claims and cancels are not affected.";
  else if (headroom === 0n) notice = `The ${stx(s.maxTvl, 0)} pilot cap is reached.`;
  else if (!consentAllChecked()) [notice, bad] = ["Check every box above before depositing.", false];

  const mode = s?.epochOpen
    ? `<p class="notice">The vault is DEPLOYED. A deposit now is queued for epoch ${s.currentEpoch} and turned into shares at that epoch's settlement price. You can cancel it until then.</p>`
    : s
      ? `<p class="notice">The vault is IDLE. A deposit now mints shares immediately at ${fmtPrice(s.pps)} STX per share.</p>`
      : "";
  const amt = parseUnits(draftDeposit, STX_DECIMALS);
  const preview = s && !s.epochOpen && amt && amt > 0n ? `<p class="notice">You would receive ${fmtShares(sharesForAssets(amt, s.totalAssets, s.supply), 6)} shares.</p>` : "";
  const inputDisabled = !address || !s || !s.initialized || s.depositsPaused || headroom === 0n;
  const btnDisabled = inputDisabled || !walletOk() || !consentAllChecked() || busy;
  el.innerHTML = `
    <div class="field">
      <label for="deposit-amount">Amount (STX).${s ? ` Up to ${fmtStx(headroom, 6)} STX of cap headroom remains.` : ""}</label>
      <input type="text" inputmode="decimal" id="deposit-amount" value="${escapeHtml(draftDeposit)}" ${inputDisabled ? "disabled" : ""} />
    </div>
    <div id="deposit-preview">${preview}</div>
    <button id="btn-deposit" ${btnDisabled ? "disabled" : ""}>${s?.epochOpen ? "Queue deposit" : "Deposit"}</button>
    ${notice ? `<p class="notice${bad ? " bad" : ""}">${notice}</p>` : ""}
    ${mode}`;
  const input = document.getElementById("deposit-amount") as HTMLInputElement;
  input.addEventListener("input", () => {
    draftDeposit = input.value;
    const a = parseUnits(draftDeposit, STX_DECIMALS);
    const p = document.getElementById("deposit-preview")!;
    p.innerHTML = s && !s.epochOpen && a && a > 0n ? `<p class="notice">You would receive ${fmtShares(sharesForAssets(a, s.totalAssets, s.supply), 6)} shares.</p>` : "";
  });
  document.getElementById("btn-deposit")?.addEventListener("click", onDeposit);
}

async function onDeposit(): Promise<void> {
  const s = vs;
  if (!address || !walletOk() || !s) return;
  const amount = parseUnits(draftDeposit, STX_DECIMALS);
  if (amount === null || amount <= 0n) return setStatus("Enter an STX amount greater than 0, with at most 6 decimal places.", "error");
  if (amount > depositHeadroom(s)) return setStatus(`That is more than the ${stx(depositHeadroom(s))} of cap headroom remaining.`, "error");
  if (!s.epochOpen && sharesForAssets(amount, s.totalAssets, s.supply) === 0n) return setStatus("That amount is too small to receive any shares.", "error");
  const who = address;
  const queuedInto = s.epochOpen ? s.currentEpoch : null;
  await runTx(
    queuedInto !== null ? "Queuing the deposit" : "Depositing",
    () => deposit(who, amount),
    (repr) => {
      draftDeposit = "";
      // (ok u0) means it was queued; the epoch it joined is the one open at signing (a later
      // epoch is also found by the recent-epoch scan).
      if (repr === "(ok u0)" && queuedInto !== null) {
        rememberEpoch(who, queuedInto);
        return `Deposit of ${stx(amount)} queued for epoch ${queuedInto}.`;
      }
      return `Deposit of ${stx(amount)} confirmed.`;
    },
  );
}

// ---------------------------------------------------------------------------
// Position + withdraw
// ---------------------------------------------------------------------------

function renderPositionPanel(): void {
  const section = document.getElementById("position-panel")!;
  const el = document.getElementById("position-body")!;
  if (!address || lastRefreshAt === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const s = vs;
  const value = shareBalance !== undefined && s ? assetsForShares(shareBalance, s.totalAssets, s.supply) : undefined;
  el.innerHTML = `
    <div class="stat-row"><span class="label">Your shares (dsSTX2), in your wallet</span><span>${show(shareBalance, "user.shares", (v) => fmtShares(v, 6))}</span></div>
    <div class="stat-row"><span class="label">Value at the current share price</span><span>${show(value, "state", (v) => stx(v))}</span></div>
    ${s?.epochOpen ? `<p class="notice">Capital at the strategy is counted at the amount sent out until it returns, so this value can change at settlement.</p>` : ""}
    <p class="notice">Shares queued for withdrawal are held by the vault and are listed under your queued items, not here. Any past fee is already reflected in the share price.</p>`;
}

function renderWithdrawPanel(): void {
  const section = document.getElementById("withdraw-panel")!;
  const el = document.getElementById("withdraw-body")!;
  if (!address || lastRefreshAt === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const s = vs;
  let notice = "";
  let bad = true;
  if (wrongNetworkNotice()) notice = wrongNetworkNotice()!;
  else if (shareBalance === undefined) notice = "Couldn't read your share balance yet. Retrying automatically.";
  else if (shareBalance === 0n) [notice, bad] = ["You don't hold any vault shares in your wallet.", false];
  else if (!s) notice = "Can't load the vault's state right now.";

  const sh = parseUnits(draftWithdraw, SHARE_DECIMALS);
  const previewFor = (v: bigint | null) =>
    s && !s.epochOpen && v && v > 0n ? `<p class="notice">You would be able to claim ${stx(assetsForShares(v, s.totalAssets, s.supply))} after the delay.</p>` : "";
  const canRequest = !!s && shareBalance !== undefined && shareBalance > 0n && walletOk() && !busy;
  const mode = s?.epochOpen
    ? `The vault is DEPLOYED. Your shares will be queued for epoch ${s.currentEpoch} and priced when it settles. You can cancel until then.`
    : `The vault is IDLE. The STX amount is fixed now and claimable after ${blocksText(WITHDRAWAL_DELAY_BURN)}.`;

  const cards = requests
    .map((r) => {
      const left = burnHeight !== undefined ? r.claimableAt - burnHeight : undefined;
      const ready = left !== undefined && left <= 0n;
      const text = left === undefined ? `claimable from Bitcoin block ${r.claimableAt.toLocaleString()}` : ready ? "claimable now" : `claimable in ${burnToDuration(left)} (Bitcoin block ${r.claimableAt.toLocaleString()})`;
      return `<div class="pending-card">
        <div class="stat-row"><span class="label">Withdrawal #${r.id}</span><span>${stx(r.amount)}</span></div>
        <div class="stat-row"><span class="label">Status</span><span>${text}</span></div>
        <button class="secondary" data-claim-id="${r.id}" ${ready && walletOk() && !busy ? "" : "disabled"}>Claim</button></div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="field">
      <label for="withdraw-shares">Shares to withdraw. You hold ${show(shareBalance, "user.shares", (v) => fmtShares(v, 6))}.</label>
      <div style="display:flex; gap:8px">
        <input type="text" inputmode="decimal" id="withdraw-shares" value="${escapeHtml(draftWithdraw)}" ${canRequest ? "" : "disabled"} />
        <button class="secondary" id="btn-withdraw-max" ${canRequest ? "" : "disabled"}>Max</button>
      </div>
    </div>
    <div id="withdraw-preview">${previewFor(sh)}</div>
    <button id="btn-request-withdrawal" ${canRequest ? "" : "disabled"}>${s?.epochOpen ? "Queue withdrawal" : "Request withdrawal"}</button>
    ${notice ? `<p class="notice${bad ? " bad" : ""}">${notice}</p>` : ""}
    <p class="notice">${mode}</p>
    ${cards || `<p class="notice">No idle withdrawal requests from this browser.</p>`}
    <div class="field" style="margin-top:16px">
      <label for="lookup-id">Check an idle withdrawal by id, for example one made on another device</label>
      <div style="display:flex; gap:8px">
        <input type="text" inputmode="numeric" id="lookup-id" value="${escapeHtml(draftLookup)}" />
        <button class="secondary" id="btn-lookup">Check</button>
      </div>
      <div id="lookup-result"></div>
    </div>`;

  const input = document.getElementById("withdraw-shares") as HTMLInputElement;
  input.addEventListener("input", () => {
    draftWithdraw = input.value;
    document.getElementById("withdraw-preview")!.innerHTML = previewFor(parseUnits(draftWithdraw, SHARE_DECIMALS));
  });
  document.getElementById("btn-withdraw-max")?.addEventListener("click", () => {
    if (shareBalance === undefined) return;
    draftWithdraw = toInput(shareBalance, SHARE_DECIMALS);
    renderWithdrawPanel();
  });
  const lookup = document.getElementById("lookup-id") as HTMLInputElement;
  lookup.addEventListener("input", () => (draftLookup = lookup.value));
  document.getElementById("btn-request-withdrawal")?.addEventListener("click", onRequestWithdrawal);
  el.querySelectorAll<HTMLButtonElement>("button[data-claim-id]").forEach((b) => b.addEventListener("click", () => onClaimIdle(Number(b.dataset.claimId))));
  document.getElementById("btn-lookup")?.addEventListener("click", onLookup);
  renderLookupResult();
}

async function onRequestWithdrawal(): Promise<void> {
  const s = vs;
  if (!address || !walletOk() || !s) return;
  const shares = parseUnits(draftWithdraw, SHARE_DECIMALS);
  if (shares === null || shares <= 0n) return setStatus("Enter a share amount greater than 0, with at most 9 decimal places.", "error");
  if (shareBalance === undefined || shares > shareBalance) return setStatus("That is more shares than your wallet holds.", "error");
  if (!s.epochOpen && assetsForShares(shares, s.totalAssets, s.supply) === 0n) return setStatus("That is too few shares to be worth any STX.", "error");
  const who = address;
  await runTx(
    s.epochOpen ? "Queuing the withdrawal" : "Requesting the withdrawal",
    () => requestWithdrawal(who, shares),
    (repr) => {
      draftWithdraw = "";
      const r = parseRequestRepr(repr);
      if (!r) return "The withdrawal confirmed, but its id couldn't be read automatically. Check the transaction for it.";
      if (r.queued) {
        rememberEpoch(who, BigInt(r.id));
        return `${fmtShares(shares, 6)} shares queued for withdrawal in epoch ${r.id}.`;
      }
      rememberRequest(who, r.id);
      return `Withdrawal #${r.id} requested.`;
    },
  );
}

const onClaimIdle = (id: number) => {
  const who = address;
  if (!who || !walletOk()) return;
  return runTx(`Claiming withdrawal #${id}`, () => claimIdle(who, id), () => {
    forgetRequest(who, id);
    return `Withdrawal #${id} claimed.`;
  });
};

async function onLookup(): Promise<void> {
  const raw = draftLookup.trim();
  if (!/^\d+$/.test(raw)) return;
  try {
    lookupResult = (await readRequest(Number(raw))) ?? "not-found";
  } catch {
    lookupResult = "error";
  }
  if (lookupResult !== "not-found" && lookupResult !== "error" && address && lookupResult.owner === address) {
    rememberRequest(address, lookupResult.id); // it's theirs: track it like one made here
    void refreshAll();
  }
  renderLookupResult();
}

function renderLookupResult(): void {
  const el = document.getElementById("lookup-result");
  if (!el) return;
  if (lookupResult === null) el.innerHTML = "";
  else if (lookupResult === "not-found") el.innerHTML = `<p class="notice">No open withdrawal with that id. It may already be claimed.</p>`;
  else if (lookupResult === "error") el.innerHTML = `<p class="notice bad">Couldn't check that just now. Try again in a moment.</p>`;
  else {
    const r = lookupResult;
    const detail = `${stx(r.amount)} · claimable from Bitcoin block ${r.claimableAt.toLocaleString()}`;
    el.innerHTML = address && r.owner === address
      ? `<p class="notice">This request is yours and is now listed above. ${detail}</p>`
      : `<p class="notice">This request belongs to another address (${shortAddr(r.owner)}). Only its owner can claim it. ${detail}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Queued and claimable epoch items
// ---------------------------------------------------------------------------

function renderQueuedPanel(): void {
  const section = document.getElementById("queued-panel")!;
  const el = document.getElementById("queued-body")!;
  if (!address || lastRefreshAt === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const ok = walletOk() && !busy;
  const cards: string[] = [];
  for (const { e, ep, dep, wd } of epochItems) {
    const open = !ep.settled;
    if (dep > 0n) {
      const [text, btn] = open
        ? [`${stx(dep)} queued, joins at settlement`, `<button class="secondary" data-act="cancel-dep" data-e="${e}" ${ok ? "" : "disabled"}>Cancel deposit</button>`]
        : ep.writtenOff
          ? [`${stx(dep)} to refund 1:1 (epoch written off)`, `<button data-act="claim-dep" data-e="${e}" ${ok ? "" : "disabled"}>Claim refund</button>`]
          : [`${stx(dep)} became ${fmtShares((dep * ep.depSharesMinted) / ep.depTotal, 6)} shares`, `<button data-act="claim-dep" data-e="${e}" ${ok ? "" : "disabled"}>Claim shares</button>`];
      cards.push(`<div class="pending-card"><div class="stat-row"><span class="label">Epoch ${e} deposit</span><span>${text}</span></div><div class="btn-row">${btn}</div></div>`);
    }
    if (wd > 0n) {
      const [text, btn] = open
        ? [`${fmtShares(wd, 6)} shares queued, priced at settlement`, `<button class="secondary" data-act="cancel-wd" data-e="${e}" ${ok ? "" : "disabled"}>Cancel withdrawal</button>`]
        : ep.writtenOff
          ? [`${fmtShares(wd, 6)} shares to hand back unpriced (epoch written off)`, `<button data-act="claim-wd" data-e="${e}" ${ok ? "" : "disabled"}>Claim shares back</button>`]
          : [`${fmtShares(wd, 6)} shares became ${stx((wd * ep.wdStxPaid) / ep.wdSharesTotal)}`, `<button data-act="claim-wd" data-e="${e}" ${ok ? "" : "disabled"}>Claim STX</button>`];
      cards.push(`<div class="pending-card"><div class="stat-row"><span class="label">Epoch ${e} withdrawal</span><span>${text}</span></div><div class="btn-row">${btn}</div></div>`);
    }
  }
  const staleNote = stale.has("user.epochs") ? `<p class="notice bad">Couldn't refresh this list just now. Showing the last good reading.</p>` : "";
  el.innerHTML = (cards.join("") || `<p class="notice">Nothing queued or waiting to be claimed in the last ${EPOCH_SCAN} epochs.</p>`) + staleNote;

  el.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const who = address;
      if (!who || !walletOk()) return;
      const e = BigInt(b.dataset.e!);
      const act = b.dataset.act;
      if (act === "cancel-dep") void runTx("Cancelling the queued deposit", () => cancelDeposit(who, e), () => "Queued deposit cancelled and refunded.");
      else if (act === "cancel-wd") void runTx("Cancelling the queued withdrawal", () => cancelWithdrawal(who, e), () => "Queued withdrawal cancelled. Your shares are back in your wallet.");
      else if (act === "claim-dep") void runTx(`Claiming the epoch ${e} deposit`, () => claimEpochDeposit(who, e), () => `Epoch ${e} deposit claimed.`);
      else if (act === "claim-wd") void runTx(`Claiming the epoch ${e} withdrawal`, () => claimEpochWithdrawal(who, e), () => `Epoch ${e} withdrawal claimed.`);
    }),
  );
}

// ---------------------------------------------------------------------------
// One path for every transaction: sign in the wallet, wait for the result, report it plainly.
// ---------------------------------------------------------------------------

async function runTx(label: string, send: () => Promise<TxResult>, onSuccess: (repr: string | undefined) => string): Promise<void> {
  if (busy) return;
  busy = true;
  renderAll();
  try {
    setStatus(`${label}: confirm in your wallet.`, "info");
    const { txid } = await send();
    if (!txid) throw new Error("no transaction id came back, so it may have been rejected in your wallet");
    setStatus(`${label}: broadcast. Confirming, which can take a few minutes.`, "info", false, txid);
    const out = await waitForTx(txid);
    if (out.status === "success") setStatus(onSuccess(out.repr), "success", false, txid);
    else if (out.status === "timeout") setStatus(`${label}: still unconfirmed after several minutes. It may still go through.`, "info", false, txid);
    else setStatus(`${label} did not go through: ${out.status}${out.repr ? ` ${out.repr}` : ""}`, "error", false, txid);
  } catch (err) {
    setStatus(`${label} failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function renderAll(): void {
  const focusedId = (document.activeElement as HTMLElement | null)?.id || null;
  renderNetworkBanner();
  renderStatusBanner();
  renderWalletArea();
  renderVaultStats();
  renderPendingPanel();
  renderConsentGate();
  renderDepositPanel();
  renderPositionPanel();
  renderWithdrawPanel();
  renderQueuedPanel();
  if (focusedId) document.getElementById(focusedId)?.focus();
}

async function init(): Promise<void> {
  renderAll();
  await refreshAll();
  setInterval(() => {
    if (document.visibilityState === "visible" && !busy) void refreshAll();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (lastRefreshAt === null || Date.now() - lastRefreshAt >= REFRESH_MS)) void refreshAll();
  });
}

void init();
