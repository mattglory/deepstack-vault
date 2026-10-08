import "./style.css";
import {
  VAULT_ADDRESS,
  VAULT_CONTRACT_NAME,
  WITHDRAWAL_DELAY_BLOCKS,
  TIMELOCK_DELAY_BLOCKS,
  FALLBACK_SEC_PER_BLOCK,
  LIVE_REFRESH_MS,
  SETTINGS_REFRESH_MS,
  PACE_REFRESH_MS,
  MIN_FIRST_DEPOSIT,
} from "./config";
import {
  readVaultLive,
  readVaultSettings,
  readShareBalance,
  readWithdrawalRequest,
  readCurrentBlockHeight,
  measureSecPerBlock,
  type FieldResults,
  type PendingChange,
  type VaultLive,
  type VaultSettings,
  type WithdrawalRequest,
} from "./reads";
import { connectWallet, disconnectWallet, getConnectedAddress, verifyMainnet } from "./wallet";
import { depositStx, requestWithdrawal, claimWithdrawal } from "./writes";
import { waitForTx, parseOkUintRepr } from "./tx";
import { rememberWithdrawalId, getKnownWithdrawalIds } from "./known-withdrawals";
import { recordHistoryPoint, getHistory } from "./history";
import { assetsForShares, sharesForDeposit, maxSharesWithinLiquidity, parseAmount, fmtStx, microToNumber, microToInput } from "./math";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let address: string | null = getConnectedAddress();
let networkOk: boolean | null = null; // null = not verified yet; retried on every refresh

// Last GOOD value per field. A field is only overwritten by a successful read; a failed read
// keeps the previous value and marks it stale. A never-read field is undefined and renders as
// "unavailable", never as 0.
let live: Partial<VaultLive> = {};
let settings: Partial<VaultSettings> = {};
let shareBalance: bigint | undefined;
let blockHeight: number | undefined;
let knownWithdrawals: WithdrawalRequest[] = [];
const stale = new Set<string>(); // keys ("live.freeBalance", ...) whose most recent read failed
let lastRefreshAt: number | null = null;
let nextSettingsAt = 0;
let nextPaceAt = 0;
let secPerBlock = FALLBACK_SEC_PER_BLOCK;
let paceMeasured = false;

let lookupResult: WithdrawalRequest | "not-found" | "error" | null = null;

const consent = { custody: false, audit: false, cap: false, withdrawal: false, fee: false, jurisdiction: false };
const consentAllChecked = () => Object.values(consent).every(Boolean);

let busy = false; // true while a tx is broadcasting/confirming; disables the action buttons

// Draft values for the free-text inputs, held in state rather than read back from the DOM.
// Every refresh rebuilds each panel's innerHTML, so without this a user mid-typing would see
// their input wiped. Restored as each input's `value` on render.
let draftDepositAmount = "";
let draftWithdrawShares = "";
let draftLookupId = "";

// Non-blocking status banner (a broadcast can take minutes to confirm, so no alert()).
type StatusKind = "info" | "success" | "error";
let status: { message: string; kind: StatusKind; loadError: boolean } | null = null;
function setStatus(message: string, kind: StatusKind, loadError = false): void {
  status = { message, kind, loadError };
  renderStatusBanner();
}
function clearStatus(): void {
  status = null;
  renderStatusBanner();
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
  el.innerHTML = `<span>${escapeHtml(status.message)}</span><button class="secondary" id="btn-dismiss-status">Dismiss</button>`;
  document.getElementById("btn-dismiss-status")!.addEventListener("click", clearStatus);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const yesNo = (b: boolean) => (b ? "yes" : "no");
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const stx0 = (v: bigint) => `${fmtStx(v, 0)} STX`;

// Block counts are the only thing the contract enforces. Real time per block drifts, so every
// duration is converted with the live-measured pace (see measureSecPerBlock), never a constant.
function blocksToDuration(blocks: number): string {
  const secs = blocks * secPerBlock;
  if (secs >= 86_400) return `about ${(secs / 86_400).toFixed(1)} days`;
  if (secs >= 3_600) return `about ${(secs / 3_600).toFixed(1)} hours`;
  return `about ${Math.max(1, Math.round(secs / 60))} minutes`;
}

const UNAVAILABLE = `<span class="unavailable">unavailable</span>`;
const STALE_TITLE = "Couldn't refresh this just now. Showing the last good reading.";
function show<T>(value: T | undefined, key: string, format: (v: T) => string): string {
  if (value === undefined) return UNAVAILABLE;
  if (stale.has(key)) return `<span class="stale" title="${STALE_TITLE}">${format(value)}</span>`;
  return format(value);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function applyFields<T>(target: Partial<T>, res: FieldResults<T>, prefix: string): void {
  for (const k of Object.keys(res.values) as (keyof T)[]) {
    target[k] = res.values[k];
    stale.delete(`${prefix}.${String(k)}`);
  }
  for (const k of res.failed) stale.add(`${prefix}.${String(k)}`);
}

async function readKnownWithdrawals(who: string): Promise<WithdrawalRequest[]> {
  const ids = getKnownWithdrawalIds(who);
  const results = await Promise.allSettled(ids.map((id) => readWithdrawalRequest(id)));
  return ids.flatMap((id, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return r.value && r.value.owner === who ? [r.value] : [];
    const prev = knownWithdrawals.find((w) => w.id === id && w.owner === who); // keep the last good reading
    return prev ? [prev] : [];
  });
}

async function doRefresh(): Promise<void> {
  const now = Date.now();
  const who = address; // snapshot: a disconnect mid-refresh must not write this user's data back
  const wantSettings = now >= nextSettingsAt;
  const wantPace = now >= nextPaceAt;
  const wantNetwork = who !== null && networkOk === null;

  const [liveR, settingsR, heightR, balanceR, withdrawalsR, paceR, netR] = await Promise.allSettled([
    readVaultLive(),
    wantSettings ? readVaultSettings() : Promise.resolve(null),
    readCurrentBlockHeight(),
    who ? readShareBalance(who) : Promise.resolve(undefined),
    who ? readKnownWithdrawals(who) : Promise.resolve([] as WithdrawalRequest[]),
    wantPace ? measureSecPerBlock(WITHDRAWAL_DELAY_BLOCKS) : Promise.resolve(null),
    wantNetwork ? verifyMainnet() : Promise.resolve(null),
  ]);

  if (liveR.status === "fulfilled") applyFields(live, liveR.value, "live");

  if (wantSettings && settingsR.status === "fulfilled" && settingsR.value) {
    applyFields(settings, settingsR.value, "settings");
    // Fully read: wait the normal interval. Partly failed: retry on the very next refresh.
    nextSettingsAt = settingsR.value.failed.length === 0 ? now + SETTINGS_REFRESH_MS : 0;
  }

  if (heightR.status === "fulfilled") {
    blockHeight = heightR.value;
    stale.delete("chain.blockHeight");
  } else stale.add("chain.blockHeight");

  if (who !== null && who === address) {
    if (balanceR.status === "fulfilled" && balanceR.value !== undefined) {
      shareBalance = balanceR.value;
      stale.delete("user.shareBalance");
    } else if (balanceR.status === "rejected") stale.add("user.shareBalance");
    if (withdrawalsR.status === "fulfilled") knownWithdrawals = withdrawalsR.value;
    if (wantNetwork && netR.status === "fulfilled" && netR.value) networkOk = netR.value.ok;
  }

  if (wantPace) {
    if (paceR.status === "fulfilled" && paceR.value !== null) {
      secPerBlock = paceR.value;
      paceMeasured = true;
      nextPaceAt = now + PACE_REFRESH_MS;
    } else nextPaceAt = now + SETTINGS_REFRESH_MS; // retry in a few minutes, not on every poll
  }

  lastRefreshAt = now;
  const { cumulativeRealizedPnl: pnl, highWaterMark: hwm } = live;
  if (pnl !== undefined && hwm !== undefined && !stale.has("live.cumulativeRealizedPnl") && !stale.has("live.highWaterMark")) {
    recordHistoryPoint(microToNumber(pnl), microToNumber(hwm));
  }

  if (Object.keys(live).length === 0 && Object.keys(settings).length === 0) {
    setStatus("Couldn't reach the Stacks API to load vault data. This happens intermittently. Retrying automatically.", "error", true);
  } else if (status?.loadError) clearStatus();

  renderAll();
}

// One refresh at a time. A refresh requested while one is running (background poll plus a
// post-transaction refresh) runs once more right after it, so nothing is silently skipped.
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
// Wallet area
// ---------------------------------------------------------------------------

function renderWalletArea(): void {
  const el = document.getElementById("wallet-area")!;
  if (!address) {
    el.innerHTML = `<button id="btn-connect">Connect wallet</button>`;
    document.getElementById("btn-connect")!.addEventListener("click", onConnect);
    return;
  }
  const netBadge = networkOk === false ? `<span class="badge bad">wrong network</span>` : networkOk === true ? `<span class="badge ok">mainnet</span>` : "";
  el.innerHTML = `<span class="muted">${shortAddr(address)}</span> ${netBadge} <button class="secondary" id="btn-disconnect">Disconnect</button>`;
  document.getElementById("btn-disconnect")!.addEventListener("click", onDisconnect);
}

function resetUserState(): void {
  shareBalance = undefined;
  knownWithdrawals = [];
  stale.delete("user.shareBalance");
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
  networkOk = null; // verified by the refresh below, and retried until it succeeds
  await refreshAll();
}

async function onDisconnect(): Promise<void> {
  await disconnectWallet();
  address = null;
  networkOk = null;
  resetUserState();
  renderAll();
}

// ---------------------------------------------------------------------------
// Vault stats (public)
// ---------------------------------------------------------------------------

function paceLine(): string {
  return paceMeasured
    ? `Times assume ${secPerBlock.toFixed(1)} seconds per block, measured over the last ${WITHDRAWAL_DELAY_BLOCKS.toLocaleString()} blocks.`
    : `Times assume ${secPerBlock.toFixed(1)} seconds per block, an earlier measurement, until a live one loads.`;
}

function updatedLine(): string {
  if (lastRefreshAt === null) return "";
  const t = new Date(lastRefreshAt).toLocaleTimeString();
  const n = stale.size;
  return n === 0 ? `Updated ${t}.` : `Updated ${t}. ${n} value${n === 1 ? "" : "s"} couldn't be refreshed and show the last good reading, underlined.`;
}

function renderVaultStats(): void {
  const el = document.getElementById("vault-stats-body")!;
  document.getElementById("vault-addr-footer")!.textContent = `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}`;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const { totalAssets, capitalAtStrategy, freeBalance, depositsPaused, strategyPaused } = live;
  const { maxTvl, performanceFeeBps, admin } = settings;
  const capKnown = totalAssets !== undefined && maxTvl !== undefined && maxTvl > 0n;
  const fillPct = capKnown ? Math.min(100, (microToNumber(totalAssets) / microToNumber(maxTvl)) * 100) : 0;
  const full = capKnown && totalAssets >= maxTvl;
  el.innerHTML = `
    <div class="stat-row"><span class="label">Phase 1 cap</span><span>${show(totalAssets, "live.totalAssets", (v) => fmtStx(v, 2))} / ${show(maxTvl, "settings.maxTvl", (v) => fmtStx(v, 0))} STX</span></div>
    <div class="cap-bar"><div class="cap-bar-fill ${full ? "full" : ""}" style="width:${fillPct}%"></div></div>
    <div class="stat-row"><span class="label">Deployed to the strategy</span><span>${show(capitalAtStrategy, "live.capitalAtStrategy", (v) => `${fmtStx(v, 2)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Free for new withdrawal requests</span><span>${show(freeBalance, "live.freeBalance", (v) => `${fmtStx(v, 2)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Performance fee</span><span>${show(performanceFeeBps, "settings.performanceFeeBps", pct)}</span></div>
    <div class="stat-row"><span class="label">Admin</span><span>${show(admin, "settings.admin", shortAddr)}</span></div>
    <div class="stat-row"><span class="label">Deposits paused</span><span>${show(depositsPaused, "live.depositsPaused", yesNo)}</span></div>
    <div class="stat-row"><span class="label">Strategy sweeps paused</span><span>${show(strategyPaused, "live.strategyPaused", yesNo)}</span></div>
    <div class="stat-row"><span class="label">Withdrawal delay</span><span>${WITHDRAWAL_DELAY_BLOCKS.toLocaleString()} blocks, ${blocksToDuration(WITHDRAWAL_DELAY_BLOCKS)}</span></div>
    <div class="stat-row"><span class="label">Notice before an admin change</span><span>${TIMELOCK_DELAY_BLOCKS.toLocaleString()} blocks, ${blocksToDuration(TIMELOCK_DELAY_BLOCKS)}</span></div>
    <div class="stat-row"><span class="label">Audit status</span><span>internal review + 60-test suite — no professional audit yet</span></div>
    <p class="updated">${paceLine()} ${updatedLine()}</p>
  `;
}

// ---------------------------------------------------------------------------
// Queued admin changes (public). The timelock only protects a depositor who can SEE a change
// coming, so every queued change the contract holds is shown here with its countdown.
// ---------------------------------------------------------------------------

interface PendingView {
  label: string;
  change: PendingChange<string> | null | undefined; // undefined = couldn't be read
  current: string;
  appliedBy: string;
}

function formatPending<T>(p: PendingChange<T> | null | undefined, f: (v: T) => string): PendingChange<string> | null | undefined {
  return p ? { value: f(p.value), executableAt: p.executableAt } : p;
}

function current<T>(v: T | undefined, f: (v: T) => string): string {
  return v === undefined ? "unknown" : f(v);
}

function pendingViews(): PendingView[] {
  const s = settings;
  return [
    { label: "Deposit cap", change: formatPending(s.pendingMaxTvl, stx0), current: current(s.maxTvl, stx0), appliedBy: "Anyone can apply it" },
    { label: "Performance fee", change: formatPending(s.pendingFeeBps, pct), current: current(s.performanceFeeBps, pct), appliedBy: "Anyone can apply it" },
    { label: "Fee recipient", change: formatPending(s.pendingFeeRecipient, shortAddr), current: current(s.feeRecipient, shortAddr), appliedBy: "Anyone can apply it" },
    { label: "Admin", change: formatPending(s.pendingAdmin, shortAddr), current: current(s.admin, shortAddr), appliedBy: "The proposed admin can accept it" },
  ];
}

function renderPendingPanel(): void {
  const el = document.getElementById("pending-body")!;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const views = pendingViews();
  const queued = views.filter((v) => v.change);
  const unknownCount = views.filter((v) => v.change === undefined).length;
  const rules = `Changes to the deposit cap, performance fee, fee recipient or admin must wait here in public for ${TIMELOCK_DELAY_BLOCKS.toLocaleString()} blocks, ${blocksToDuration(TIMELOCK_DELAY_BLOCKS)}, before they can take effect. A queued change has no cancel. It can only be replaced by queuing a different value, which restarts the wait.`;

  if (queued.length === 0) {
    el.innerHTML =
      unknownCount > 0
        ? `<p class="notice bad">Couldn't check for queued changes just now. Retrying automatically.</p><p class="notice">${rules}</p>`
        : `<p>None queued.</p><p class="notice">${rules}</p>`;
    return;
  }

  const cards = queued
    .map((v) => {
      const c = v.change!;
      const remaining = blockHeight !== undefined ? c.executableAt - blockHeight : undefined;
      const when =
        remaining === undefined
          ? `Can take effect from block ${c.executableAt.toLocaleString()}.`
          : remaining <= 0
            ? `Can take effect now. ${v.appliedBy}.`
            : `Can take effect from block ${c.executableAt.toLocaleString()}, in ${blocksToDuration(remaining)}. ${v.appliedBy} then.`;
      return `
      <div class="pending-card">
        <div class="stat-row"><span class="label">${v.label}</span><span>${v.current} to ${c.value}</span></div>
        <p class="notice">${when}</p>
      </div>`;
    })
    .join("");

  const exitWarning =
    live.freeBalance === 0n
      ? `<p class="notice bad">The vault holds no free STX right now because it's all deployed to the strategy, so the contract would reject a withdrawal request. You may not be able to exit before a queued change takes effect.</p>`
      : "";
  const incomplete = unknownCount > 0 ? `<p class="notice bad">Some checks for queued changes failed just now, so this list may be incomplete.</p>` : "";
  el.innerHTML = cards + exitWarning + incomplete + `<p class="notice">${rules}</p>`;
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

const CONSENT_ITEMS: { key: keyof typeof consent; label: string }[] = [
  {
    key: "custody",
    label:
      "This vault has a single admin, and the admin's cooperation is required to get swept capital back. When the admin moves vault funds out to run the trading strategy, the contract cannot verify what happens to that capital next, or confirm the result reported back is the whole truth. The admin also holds a kill switch and can pause new deposits and strategy sweeps at any time — these are real, discretionary powers held by one person, not purely automated contract logic.",
  },
  {
    key: "audit",
    label: "This contract has had an internal manual review and a 60-test automated suite — it has NOT had a professional third-party security audit.",
  },
  {
    key: "cap",
    label: "Deposits are deliberately capped during this pilot phase. The cap is only raised after a defined, published review — not on demand.",
  },
  {
    key: "withdrawal",
    label:
      "A withdrawal request can take real time to become claimable, and can be rejected at the moment you ask (not paused — rejected, so you'd retry later) if the vault's capital is fully deployed to the strategy right then. Once a request is accepted, it cannot later be blocked or frozen.",
  },
  {
    key: "fee",
    label: "DeepStack charges a performance fee only when realized gains take the vault as a whole above its previous high, never on deposits or paper gains. The high is tracked for the whole vault, not per depositor, so I could pay part of a fee while still below my own entry value.",
  },
  {
    key: "jurisdiction",
    label: "I am not a resident of, and am not accessing this from, a jurisdiction where interacting with this contract would be unlawful, and I am depositing on my own behalf.",
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
    `<p class="notice">This is not an investment. This interface lets you deposit STX into a published Clarity vault contract that executes a documented strategy for a fee — it is not a promise of profit or a solicitation to invest. Full disclosure: <a href="https://github.com/mattglory/deepstack/blob/main/docs/VAULT_DISCLOSURE.md" target="_blank" rel="noopener">VAULT_DISCLOSURE.md</a>.</p>`;

  el.querySelectorAll<HTMLInputElement>("input[data-consent]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.consent as keyof typeof consent;
      consent[key] = input.checked;
      renderDepositPanel();
    });
  });
}

// ---------------------------------------------------------------------------
// Deposit panel
// ---------------------------------------------------------------------------

function deployedNote(extra: string): string {
  const deployed = live.capitalAtStrategy;
  if (deployed === undefined || deployed === 0n) return "";
  return `<p class="notice">${fmtStx(deployed, 2)} STX of the vault is deployed to the strategy and counted at the amount sent out, not its current market value. ${extra}</p>`;
}

function renderDepositPanel(): void {
  const el = document.getElementById("deposit-body")!;
  if (lastRefreshAt === null) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const { totalAssets, depositsPaused, shareSupply } = live;
  const { maxTvl } = settings;
  const known = totalAssets !== undefined && maxTvl !== undefined && depositsPaused !== undefined && shareSupply !== undefined;
  const headroom = known && maxTvl > totalAssets ? maxTvl - totalAssets : 0n;
  const full = known && headroom === 0n;
  const paused = depositsPaused === true;
  const connected = address !== null;
  const gateOpen = consentAllChecked();

  let notice = "";
  let bad = true;
  if (!connected) [notice, bad] = ["Connect your wallet to deposit.", false];
  else if (networkOk === false) notice = "Your wallet isn't on Stacks mainnet. Switch networks before depositing.";
  else if (!known) notice = "Can't confirm the vault's cap and pause state right now, so deposits stay disabled until they load.";
  else if (paused) notice = "Deposits are paused by the vault admin. Withdrawal requests and claims are not affected.";
  else if (full) notice = `This vault is full for Phase 1: the ${fmtStx(maxTvl, 0)} STX cap is reached. Check back after the next published cap review.`;
  else if (!gateOpen) [notice, bad] = ["Check every box above before depositing.", false];

  const inputDisabled = !connected || !known || paused || full;
  const buttonDisabled = inputDisabled || networkOk === false || !gateOpen || busy;
  el.innerHTML = `
    <div class="field">
      <label for="deposit-amount">Amount (STX).${known ? ` Up to ${fmtStx(headroom, 6)} STX of cap headroom remains.` : ""}</label>
      <input type="number" id="deposit-amount" min="0" step="0.000001" ${known ? `max="${microToInput(headroom)}"` : ""} value="${draftDepositAmount}" ${inputDisabled ? "disabled" : ""} />
    </div>
    <button id="btn-deposit" ${buttonDisabled ? "disabled" : ""}>Deposit</button>
    ${notice ? `<p class="notice${bad ? " bad" : ""}">${notice}</p>` : ""}
    ${deployedNote("New shares are priced on that basis, and the real result is only known when that capital comes back.")}
  `;

  const amountInput = document.getElementById("deposit-amount") as HTMLInputElement | null;
  amountInput?.addEventListener("input", () => {
    const v = parseAmount(amountInput.value);
    if (known && v !== null && v > headroom) amountInput.value = microToInput(headroom);
    draftDepositAmount = amountInput.value;
  });
  document.getElementById("btn-deposit")?.addEventListener("click", onDeposit);
}

async function onDeposit(): Promise<void> {
  if (!address || networkOk === false) return;
  const { totalAssets, depositsPaused, shareSupply } = live;
  const { maxTvl } = settings;
  if (totalAssets === undefined || maxTvl === undefined || shareSupply === undefined || depositsPaused !== false) {
    setStatus("Deposits aren't available right now.", "error");
    return;
  }
  const amount = parseAmount(draftDepositAmount);
  if (amount === null || amount <= 0n) {
    setStatus("Enter an STX amount greater than 0, with at most 6 decimal places.", "error");
    return;
  }
  const headroom = maxTvl > totalAssets ? maxTvl - totalAssets : 0n;
  if (amount > headroom) {
    setStatus(`That's more than the ${fmtStx(headroom, 6)} STX of cap headroom remaining.`, "error");
    return;
  }
  if (shareSupply === 0n && amount < MIN_FIRST_DEPOSIT) {
    setStatus("The first deposit into an empty vault must be at least 1 STX.", "error");
    return;
  }
  if (sharesForDeposit(amount, totalAssets, shareSupply) === 0n) {
    setStatus("That amount is too small to receive any shares.", "error");
    return;
  }
  busy = true;
  renderDepositPanel();
  try {
    const { txid } = await depositStx(address, amount);
    if (!txid) throw new Error("no transaction id came back, so the request may have been rejected in your wallet");
    setStatus(`Broadcast ${txid}. Confirming, which can take a few minutes.`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") {
      draftDepositAmount = "";
      setStatus(`Deposit confirmed: ${txid}`, "success");
    } else {
      setStatus(`The deposit did not go through: ${outcome.status}${outcome.repr ? ` (${outcome.repr})` : ""}`, "error");
    }
  } catch (err) {
    setStatus(`Deposit failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

// ---------------------------------------------------------------------------
// Position panel (personal). DeepStack's fee is charged on the VAULT's cumulative realized P&L
// as a whole (contracts/deepstack-vault.clar), not per depositor. Any past fee is already in
// the share value below, not a separate charge at withdrawal time.
// ---------------------------------------------------------------------------

function renderPositionPanel(): void {
  const section = document.getElementById("position-panel")!;
  const el = document.getElementById("position-body")!;
  if (!address || lastRefreshAt === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const { totalAssets, shareSupply, cumulativeRealizedPnl, highWaterMark } = live;
  // Exactly what the contract's assets-for-shares returns for your whole balance right now,
  // i.e. what a withdrawal request for all of it would lock (liquidity permitting).
  const value = shareBalance !== undefined && totalAssets !== undefined && shareSupply !== undefined ? assetsForShares(shareBalance, totalAssets, shareSupply) : undefined;
  const valueStale = stale.has("user.shareBalance") || stale.has("live.totalAssets") || stale.has("live.shareSupply");
  const valueHtml = value === undefined ? UNAVAILABLE : valueStale ? `<span class="stale" title="${STALE_TITLE}">${fmtStx(value, 6)} STX</span>` : `${fmtStx(value, 6)} STX`;
  const fee = settings.performanceFeeBps !== undefined ? pct(settings.performanceFeeBps) : "performance";

  el.innerHTML = `
    <div class="stat-row"><span class="label">Your shares (dsSTX)</span><span>${show(shareBalance, "user.shareBalance", (v) => fmtStx(v, 6))}</span></div>
    <div class="stat-row"><span class="label">Your position, as the contract values it now</span><span>${valueHtml}</span></div>
    <div class="stat-row"><span class="label">Vault cumulative realized P&amp;L</span><span>${show(cumulativeRealizedPnl, "live.cumulativeRealizedPnl", (v) => `${fmtStx(v, 6)} STX`)}</span></div>
    <div class="stat-row"><span class="label">Vault high-water mark</span><span>${show(highWaterMark, "live.highWaterMark", (v) => `${fmtStx(v, 6)} STX`)}</span></div>
    ${deployedNote("Its real result is only known when it comes back, so this value can change then.")}
    <p class="notice">The ${fee} fee is charged on the vault's realized P&amp;L as a whole, only above the vault's prior peak, and is already reflected in the value above. There is no separate fee when you withdraw.</p>
    ${renderHwmChart(getHistory())}
  `;
}

function renderHwmChart(history: { t: number; pnlStx: number; hwmStx: number }[]): string {
  if (history.length < 2) return `<p class="notice">Chart builds up from your own visits over time. Not enough history yet.</p>`;
  const w = 600, h = 60, pad = 4;
  const all = history.flatMap((p) => [p.pnlStx, p.hwmStx]);
  const min = Math.min(...all, 0), max = Math.max(...all, 0.000001);
  const x = (i: number) => pad + (i / (history.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad);
  const pnlPts = history.map((p, i) => `${x(i)},${y(p.pnlStx)}`).join(" ");
  const hwmPts = history.map((p, i) => `${x(i)},${y(p.hwmStx)}`).join(" ");
  return `
    <svg class="hwm-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${hwmPts}" fill="none" stroke="#e8a33d" stroke-width="2" />
      <polyline points="${pnlPts}" fill="none" stroke="#4fae6e" stroke-width="2" />
    </svg>
    <p class="notice">High-water mark (orange) vs. cumulative realized P&amp;L (green), built from this browser's own visits, not a full history.</p>
  `;
}

// ---------------------------------------------------------------------------
// Withdraw panel
// ---------------------------------------------------------------------------

function claimStatusText(w: WithdrawalRequest): { text: string; claimable: boolean } {
  if (w.claimed) return { text: "claimed", claimable: false };
  if (blockHeight === undefined) return { text: `claimable from block ${w.claimableAt.toLocaleString()}`, claimable: false };
  const remaining = w.claimableAt - blockHeight;
  return remaining <= 0 ? { text: "claimable now", claimable: true } : { text: `claimable in ${blocksToDuration(remaining)}`, claimable: false };
}

function renderWithdrawPanel(): void {
  const section = document.getElementById("withdraw-panel")!;
  const el = document.getElementById("withdraw-body")!;
  if (!address || lastRefreshAt === null) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // The contract only ACCEPTS a request whose locked amount fits in the vault's free STX
  // (ERR-INSUFFICIENT-LIQUIDITY, u107), so cap what's requestable to that up front instead of
  // letting a user pay a fee for a request that is certain to be rejected.
  const { freeBalance, totalAssets, shareSupply } = live;
  const liquidityKnown = freeBalance !== undefined && totalAssets !== undefined && shareSupply !== undefined;
  const maxByLiquidity = liquidityKnown ? maxSharesWithinLiquidity(freeBalance, totalAssets, shareSupply) : undefined;
  const requestable = maxByLiquidity !== undefined && shareBalance !== undefined ? (shareBalance < maxByLiquidity ? shareBalance : maxByLiquidity) : undefined;

  let notice = "";
  let bad = true;
  if (shareBalance === undefined) notice = "Couldn't read your share balance yet. Retrying automatically.";
  else if (shareBalance === 0n) [notice, bad] = ["You don't hold any vault shares.", false];
  else if (!liquidityKnown) notice = "Can't check how much free STX the vault holds right now, so requests stay disabled until it loads.";
  else if (freeBalance === 0n)
    notice = "The vault holds no free STX right now because it's all deployed to the strategy, so the contract would reject a withdrawal request. Requests become possible again when the admin returns capital or new deposits arrive.";
  else if (requestable !== undefined && requestable < shareBalance)
    [notice, bad] = [`Only ${fmtStx(requestable, 6)} of your shares, worth ${fmtStx(assetsForShares(requestable, totalAssets, shareSupply), 6)} STX, can be requested right now. That's all the free STX the vault holds.`, false];

  const canRequest = requestable !== undefined && requestable > 0n && networkOk !== false && !busy;
  const pendingCards = knownWithdrawals
    .map((w) => {
      const s = claimStatusText(w);
      return `
      <div class="pending-card">
        <div class="stat-row"><span class="label">Withdrawal #${w.id}</span><span>${fmtStx(w.lockedStx, 6)} STX</span></div>
        <div class="stat-row"><span class="label">Status</span><span>${s.text}</span></div>
        ${!w.claimed ? `<button class="secondary" data-claim-id="${w.id}" ${!s.claimable || busy || networkOk === false ? "disabled" : ""}>Claim</button>` : ""}
      </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="field">
      <label for="withdraw-shares">Shares to redeem. You hold ${show(shareBalance, "user.shareBalance", (v) => fmtStx(v, 6))}.</label>
      <input type="number" id="withdraw-shares" min="0" step="0.000001" ${requestable !== undefined ? `max="${microToInput(requestable)}"` : ""} value="${draftWithdrawShares}" ${requestable === undefined || requestable === 0n ? "disabled" : ""} />
    </div>
    <button id="btn-request-withdrawal" ${canRequest ? "" : "disabled"}>Request withdrawal</button>
    ${notice ? `<p class="notice${bad ? " bad" : ""}">${notice}</p>` : ""}
    <p class="notice">A request becomes claimable ${WITHDRAWAL_DELAY_BLOCKS.toLocaleString()} blocks later, ${blocksToDuration(WITHDRAWAL_DELAY_BLOCKS)}. The STX amount is fixed when you request.</p>

    ${pendingCards || `<p class="notice">No withdrawal requests from this browser yet.</p>`}

    <div class="field" style="margin-top:16px">
      <label for="lookup-id">Check a withdrawal by id, for example from a different device</label>
      <div style="display:flex; gap:8px">
        <input type="number" id="lookup-id" min="0" step="1" value="${draftLookupId}" />
        <button class="secondary" id="btn-lookup">Check</button>
      </div>
      <div id="lookup-result"></div>
    </div>
  `;

  const sharesInput = document.getElementById("withdraw-shares") as HTMLInputElement;
  sharesInput.addEventListener("input", () => {
    const v = parseAmount(sharesInput.value);
    if (requestable !== undefined && v !== null && v > requestable) sharesInput.value = microToInput(requestable);
    draftWithdrawShares = sharesInput.value;
  });
  const lookupInput = document.getElementById("lookup-id") as HTMLInputElement;
  lookupInput.addEventListener("input", () => {
    draftLookupId = lookupInput.value;
  });

  document.getElementById("btn-request-withdrawal")?.addEventListener("click", onRequestWithdrawal);
  el.querySelectorAll<HTMLButtonElement>("button[data-claim-id]").forEach((btn) => {
    btn.addEventListener("click", () => onClaim(Number(btn.dataset.claimId)));
  });
  document.getElementById("btn-lookup")?.addEventListener("click", onLookup);
  renderLookupResult();
}

async function onRequestWithdrawal(): Promise<void> {
  if (!address || networkOk === false) return;
  const shares = parseAmount(draftWithdrawShares);
  if (shares === null || shares <= 0n) {
    setStatus("Enter a share amount greater than 0, with at most 6 decimal places.", "error");
    return;
  }
  if (shareBalance === undefined || shares > shareBalance) {
    setStatus("That's more shares than you hold.", "error");
    return;
  }
  const { freeBalance, totalAssets, shareSupply } = live;
  if (freeBalance === undefined || totalAssets === undefined || shareSupply === undefined) {
    setStatus("Can't check the vault's free STX right now. Try again in a moment.", "error");
    return;
  }
  const locked = assetsForShares(shares, totalAssets, shareSupply);
  if (locked === 0n) {
    setStatus("That's too few shares. The request would lock 0 STX and could never be claimed.", "error");
    return;
  }
  if (locked > freeBalance) {
    setStatus(`That request would lock ${fmtStx(locked, 6)} STX, but the vault only holds ${fmtStx(freeBalance, 6)} free STX right now, so the contract would reject it.`, "error");
    return;
  }
  busy = true;
  renderWithdrawPanel();
  try {
    const { txid } = await requestWithdrawal(address, shares);
    if (!txid) throw new Error("no transaction id came back, so the request may have been rejected in your wallet");
    setStatus(`Broadcast ${txid}. Confirming, which can take a few minutes.`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") {
      const id = parseOkUintRepr(outcome.repr);
      if (id !== null) {
        rememberWithdrawalId(address, id);
        draftWithdrawShares = "";
        setStatus(`Withdrawal #${id} requested and confirmed: ${txid}`, "success");
      } else {
        setStatus("The withdrawal request confirmed, but its id couldn't be read automatically. Use the lookup below once you know it.", "error");
      }
    } else {
      setStatus(`The withdrawal request did not go through: ${outcome.status}${outcome.repr ? ` (${outcome.repr})` : ""}`, "error");
    }
  } catch (err) {
    setStatus(`Withdrawal request failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function onClaim(id: number): Promise<void> {
  if (!address || networkOk === false) return;
  busy = true;
  renderWithdrawPanel();
  try {
    // claimWithdrawal re-reads the request from the chain and declares its exact payout and
    // share burn as post-conditions (see writes.ts).
    const { txid } = await claimWithdrawal(address, id);
    if (!txid) throw new Error("no transaction id came back, so the request may have been rejected in your wallet");
    setStatus(`Broadcast ${txid}. Confirming, which can take a few minutes.`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") setStatus(`Withdrawal #${id} claimed: ${txid}`, "success");
    else setStatus(`The claim did not go through: ${outcome.status}${outcome.repr ? ` (${outcome.repr})` : ""}`, "error");
  } catch (err) {
    setStatus(`Claim failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function onLookup(): Promise<void> {
  const raw = draftLookupId.trim();
  const id = Number(raw);
  if (raw === "" || !Number.isInteger(id) || id < 0) return;
  try {
    lookupResult = (await readWithdrawalRequest(id)) ?? "not-found";
  } catch (err) {
    console.warn("withdrawal lookup failed", err);
    lookupResult = "error";
  }
  renderLookupResult();
}

function renderLookupResult(): void {
  const el = document.getElementById("lookup-result");
  if (!el) return;
  if (lookupResult === null) el.innerHTML = "";
  else if (lookupResult === "not-found") el.innerHTML = `<p class="notice">No withdrawal request with that id.</p>`;
  else if (lookupResult === "error") el.innerHTML = `<p class="notice bad">Couldn't check that just now. Try again in a moment.</p>`;
  else {
    const w = lookupResult;
    el.innerHTML = `<p class="notice">Owner ${shortAddr(w.owner)} · ${fmtStx(w.lockedStx, 6)} STX · ${claimStatusText(w).text}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function renderAll(): void {
  // Panels are rebuilt with innerHTML, which would drop keyboard focus from a field the user
  // is typing in whenever a background refresh lands. Put it back afterwards.
  const focusedId = (document.activeElement as HTMLElement | null)?.id || null;
  renderStatusBanner();
  renderWalletArea();
  renderVaultStats();
  renderPendingPanel();
  renderConsentGate();
  renderDepositPanel();
  renderPositionPanel();
  renderWithdrawPanel();
  if (focusedId) document.getElementById(focusedId)?.focus();
}

async function init(): Promise<void> {
  renderAll();
  await refreshAll();
  // Light polling so countdowns and balances stay current. Skipped while the tab is hidden and
  // caught up as soon as it's visible again.
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshAll();
  }, LIVE_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (lastRefreshAt === null || Date.now() - lastRefreshAt >= LIVE_REFRESH_MS)) void refreshAll();
  });
}

void init();
