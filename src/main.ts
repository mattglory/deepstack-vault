import "./style.css";
import { VAULT_ADDRESS, VAULT_CONTRACT_NAME, WITHDRAWAL_DELAY_BLOCKS, TIMELOCK_DELAY_BLOCKS, ASSUMED_SEC_PER_BLOCK } from "./config";
import { readVaultStatus, readShareBalance, readWithdrawalRequest, readCurrentBlockHeight, type VaultStatus, type WithdrawalRequest } from "./reads";
import { connectWallet, disconnectWallet, getConnectedAddress, verifyMainnet } from "./wallet";
import { depositStx, requestWithdrawal, claimWithdrawal } from "./writes";
import { waitForTx, parseOkUintRepr } from "./tx";
import { rememberWithdrawalId, getKnownWithdrawalIds } from "./known-withdrawals";
import { recordHistoryPoint, getHistory } from "./history";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let address: string | null = getConnectedAddress();
let networkOk: boolean | null = null;
let vault: VaultStatus | null = null;
let shareBalance = 0;
let blockHeight: number | null = null;
let knownWithdrawals: WithdrawalRequest[] = [];
let lookupResult: WithdrawalRequest | null | "not-found" = null;

const consent = { custody: false, audit: false, cap: false, withdrawal: false, fee: false, jurisdiction: false };
const consentAllChecked = () => Object.values(consent).every(Boolean);

let busy = false; // true while a tx is broadcasting/confirming — disables the relevant button

// Draft values for the three free-text inputs, held in state rather than read back from the
// DOM. renderAll() runs every 60s (background poll) and after every action, fully replacing
// each panel's innerHTML — without this, a user mid-typing a deposit amount would see it
// silently wiped by the next background refresh. Restored as each input's `value` on render.
let draftDepositAmount = "";
let draftWithdrawShares = "";
let draftLookupId = "";

// Non-blocking status banner — replaces alert() for anything that isn't a hard validation
// stop, since a broadcast can take minutes to confirm and shouldn't freeze the page.
type StatusKind = "info" | "success" | "error";
let status: { message: string; kind: StatusKind } | null = null;
function setStatus(message: string, kind: StatusKind): void {
  status = { message, kind };
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
  el.innerHTML = `<span>${status.message}</span><button class="secondary" id="btn-dismiss-status">Dismiss</button>`;
  document.getElementById("btn-dismiss-status")!.addEventListener("click", clearStatus);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmt = (n: number, dp = 2) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function blocksToEta(blocksRemaining: number): string {
  if (blocksRemaining <= 0) return "now";
  const secs = blocksRemaining * ASSUMED_SEC_PER_BLOCK;
  const days = secs / 86400;
  if (days >= 1) return `~${days.toFixed(1)} days`;
  return `~${(secs / 3600).toFixed(1)} hours`;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshAll(): Promise<void> {
  try {
    const [v, height] = await Promise.all([readVaultStatus(), readCurrentBlockHeight()]);
    vault = v;
    blockHeight = height;
    recordHistoryPoint(v.cumulativeRealizedPnlStx, v.highWaterMarkStx);
    if (address) {
      shareBalance = await readShareBalance(address);
      const ids = getKnownWithdrawalIds(address);
      knownWithdrawals = (await Promise.all(ids.map((id) => readWithdrawalRequest(id)))).filter((w): w is WithdrawalRequest => w !== null && w.owner === address);
    } else {
      shareBalance = 0;
      knownWithdrawals = [];
    }
  } catch (err) {
    console.error("refresh failed", err);
    // A failed FIRST load must not leave the page stuck on "loading..." forever with no
    // indication anything is wrong (exactly what happened live on 2026-10-06, caught by a
    // real browser session, before this fix existed). A failed background refresh (vault
    // already loaded once) is quieter -- the stats just go stale, no need to alarm the user
    // over one missed poll.
    if (!vault) setStatus(`Couldn't load vault data: ${(err as Error).message}. Retrying automatically.`, "error");
  }
  renderAll();
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

async function onConnect(): Promise<void> {
  try {
    address = await connectWallet();
    const net = await verifyMainnet();
    networkOk = net.ok;
    await refreshAll();
  } catch (err) {
    setStatus(`Connect failed: ${(err as Error).message}`, "error");
  }
}

async function onDisconnect(): Promise<void> {
  await disconnectWallet();
  address = null;
  networkOk = null;
  renderAll();
}

// ---------------------------------------------------------------------------
// Vault stats (public)
// ---------------------------------------------------------------------------

function renderVaultStats(): void {
  const el = document.getElementById("vault-stats-body")!;
  document.getElementById("vault-addr-footer")!.textContent = `${VAULT_ADDRESS}.${VAULT_CONTRACT_NAME}`;
  if (!vault) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const fillPct = vault.maxTvlStx > 0 ? Math.min(100, (vault.totalAssetsStx / vault.maxTvlStx) * 100) : 0;
  const full = vault.totalAssetsStx >= vault.maxTvlStx;
  el.innerHTML = `
    <div class="stat-row"><span class="label">Phase 1 cap</span><span>${fmt(vault.totalAssetsStx, 2)} / ${fmt(vault.maxTvlStx, 0)} STX</span></div>
    <div class="cap-bar"><div class="cap-bar-fill ${full ? "full" : ""}" style="width:${fillPct}%"></div></div>
    <div class="stat-row"><span class="label">Performance fee</span><span>${(vault.performanceFeeBps / 100).toFixed(1)}%</span></div>
    <div class="stat-row"><span class="label">Admin</span><span>${shortAddr(vault.admin)}</span></div>
    <div class="stat-row"><span class="label">Deposits paused</span><span>${vault.depositsPaused ? "yes" : "no"}</span></div>
    <div class="stat-row"><span class="label">Admin parameter-change notice</span><span>${blocksToEta(TIMELOCK_DELAY_BLOCKS)} minimum</span></div>
    <div class="stat-row"><span class="label">Audit status</span><span>internal review + 60-test suite — no professional audit yet</span></div>
  `;
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
    label: "DeepStack charges a performance fee only on realized gains above the vault's own all-time high — never on deposits, never on paper gains, never on losses.",
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
    ).join("") + `<p class="notice">This is not an investment. This interface lets you deposit STX into a published Clarity vault contract that executes a documented strategy for a fee — it is not a promise of profit or a solicitation to invest. Full disclosure: <a href="https://github.com/mattglory/deepstack/blob/main/docs/VAULT_DISCLOSURE.md" target="_blank" rel="noopener">VAULT_DISCLOSURE.md</a>.</p>`;

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

function renderDepositPanel(): void {
  const el = document.getElementById("deposit-body")!;
  if (!vault) {
    el.innerHTML = `<div class="skeleton">loading…</div>`;
    return;
  }
  const headroom = Math.max(0, vault.maxTvlStx - vault.totalAssetsStx);
  const full = headroom <= 0;
  const connected = Boolean(address);
  const gateOpen = consentAllChecked();

  let notice = "";
  if (!connected) notice = `<p class="notice">Connect your wallet to deposit.</p>`;
  else if (networkOk === false) notice = `<p class="notice bad">Your wallet isn't on Stacks mainnet — switch networks before depositing.</p>`;
  else if (full) notice = `<p class="notice bad">This vault is full for Phase 1 — 500 STX cap reached. Check back after the next published cap review.</p>`;
  else if (!gateOpen) notice = `<p class="notice">Check every box above before depositing.</p>`;

  el.innerHTML = `
    <div class="field">
      <label>Amount (STX) — up to ${fmt(headroom, 2)} STX of headroom remaining</label>
      <input type="number" id="deposit-amount" min="0" step="0.000001" max="${headroom}" value="${draftDepositAmount}" ${!connected || full ? "disabled" : ""} />
    </div>
    <button id="btn-deposit" ${!connected || !gateOpen || full || busy ? "disabled" : ""}>Deposit</button>
    ${notice}
  `;

  const amountInput = document.getElementById("deposit-amount") as HTMLInputElement | null;
  amountInput?.addEventListener("input", () => {
    const v = Number(amountInput.value);
    if (v > headroom) amountInput.value = String(headroom);
    draftDepositAmount = amountInput.value;
  });
  document.getElementById("btn-deposit")?.addEventListener("click", onDeposit);
}

async function onDeposit(): Promise<void> {
  if (!address || !vault) return;
  const amountInput = document.getElementById("deposit-amount") as HTMLInputElement;
  const amount = Number(amountInput.value);
  const headroom = Math.max(0, vault.maxTvlStx - vault.totalAssetsStx);
  if (!(amount > 0) || amount > headroom) {
    setStatus("Enter a valid amount within the remaining cap headroom.", "error");
    return;
  }
  busy = true;
  renderDepositPanel();
  try {
    const { txid } = await depositStx(address, amount);
    if (!txid) throw new Error("no txid returned — the request may have been rejected in your wallet");
    setStatus(`Broadcast: ${txid} — confirming, this can take a few minutes…`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") {
      draftDepositAmount = "";
      setStatus(`Deposit confirmed: ${txid}`, "success");
    } else {
      setStatus(`Transaction did not succeed: ${outcome.status}${outcome.repr ? ` — ${outcome.repr}` : ""}`, "error");
    }
  } catch (err) {
    setStatus(`Deposit failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

// ---------------------------------------------------------------------------
// Position panel (personal) — vault-wide HWM/P&L, your share of it. DeepStack's fee is charged
// on the VAULT's cumulative realized P&L as a whole (see contracts/deepstack-vault.clar), not
// per depositor — any past fee is already reflected in the current share price below, not a
// separate charge you pay at withdrawal time.
// ---------------------------------------------------------------------------

function renderPositionPanel(): void {
  const section = document.getElementById("position-panel")!;
  const el = document.getElementById("position-body")!;
  if (!address || !vault) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const yourShareOfSupply = vault.tokenTotalSupply > 0 ? shareBalance / vault.tokenTotalSupply : 0;
  const yourValueStx = yourShareOfSupply * vault.totalAssetsStx;
  const history = getHistory();

  el.innerHTML = `
    <div class="stat-row"><span class="label">Your shares (dsSTX)</span><span>${fmt(shareBalance, 6)}</span></div>
    <div class="stat-row"><span class="label">Your position's current value</span><span>${fmt(yourValueStx, 6)} STX</span></div>
    <div class="stat-row"><span class="label">Vault cumulative realized P&amp;L</span><span>${fmt(vault.cumulativeRealizedPnlStx, 6)} STX</span></div>
    <div class="stat-row"><span class="label">Vault high-water mark</span><span>${fmt(vault.highWaterMarkStx, 6)} STX</span></div>
    <p class="notice">The 10% performance fee is charged on the vault's realized P&amp;L as a whole, only above its prior peak, and is already reflected in the share value above — there is no separate fee charged when you withdraw.</p>
    ${renderHwmChart(history)}
  `;
}

function renderHwmChart(history: { t: number; pnlStx: number; hwmStx: number }[]): string {
  if (history.length < 2) return `<p class="notice">Chart builds up from your own visits over time — not enough history yet.</p>`;
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
    <p class="notice">High-water mark (orange) vs. cumulative realized P&amp;L (green) — built from this browser's own visits, not a full history.</p>
  `;
}

// ---------------------------------------------------------------------------
// Withdraw panel
// ---------------------------------------------------------------------------

function renderWithdrawPanel(): void {
  const section = document.getElementById("withdraw-panel")!;
  const el = document.getElementById("withdraw-body")!;
  if (!address || !vault) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const etaBlocks = WITHDRAWAL_DELAY_BLOCKS;
  const pendingCards = knownWithdrawals
    .map((w) => {
      const remaining = blockHeight !== null ? Math.max(0, w.claimableAt - blockHeight) : null;
      const claimable = remaining === 0;
      return `
      <div class="pending-card">
        <div class="stat-row"><span class="label">Withdrawal #${w.id}</span><span>${fmt(w.lockedStxAmount, 6)} STX</span></div>
        <div class="stat-row"><span class="label">Status</span><span>${w.claimed ? "claimed" : claimable ? "claimable now" : `claimable in ${remaining !== null ? blocksToEta(remaining) : "…"}`}</span></div>
        ${!w.claimed ? `<button class="secondary" data-claim-id="${w.id}" ${!claimable || busy ? "disabled" : ""}>Claim</button>` : ""}
      </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="field">
      <label>Request a withdrawal — shares to redeem (you hold ${fmt(shareBalance, 6)})</label>
      <input type="number" id="withdraw-shares" min="0" step="0.000001" max="${shareBalance}" value="${draftWithdrawShares}" />
    </div>
    <button id="btn-request-withdrawal" ${shareBalance <= 0 || busy ? "disabled" : ""}>Request withdrawal</button>
    <p class="notice">Takes about ${blocksToEta(etaBlocks)} from request to claimable, and can be rejected at request time (not paused) if the vault's capital is currently deployed to the strategy.</p>

    ${pendingCards || `<p class="notice">No withdrawal requests from this browser yet.</p>`}

    <div class="field" style="margin-top:16px">
      <label>Check a withdrawal by id (e.g. if you're on a different device)</label>
      <div style="display:flex; gap:8px">
        <input type="number" id="lookup-id" min="0" step="1" value="${draftLookupId}" />
        <button class="secondary" id="btn-lookup">Check</button>
      </div>
      <div id="lookup-result"></div>
    </div>
  `;

  const sharesInput = document.getElementById("withdraw-shares") as HTMLInputElement;
  sharesInput.addEventListener("input", () => { draftWithdrawShares = sharesInput.value; });
  const lookupInput = document.getElementById("lookup-id") as HTMLInputElement;
  lookupInput.addEventListener("input", () => { draftLookupId = lookupInput.value; });

  document.getElementById("btn-request-withdrawal")?.addEventListener("click", onRequestWithdrawal);
  el.querySelectorAll<HTMLButtonElement>("button[data-claim-id]").forEach((btn) => {
    btn.addEventListener("click", () => onClaim(Number(btn.dataset.claimId)));
  });
  document.getElementById("btn-lookup")?.addEventListener("click", onLookup);
  renderLookupResult();
}

async function onRequestWithdrawal(): Promise<void> {
  if (!address) return;
  const input = document.getElementById("withdraw-shares") as HTMLInputElement;
  const shares = Number(input.value);
  if (!(shares > 0) || shares > shareBalance) {
    setStatus("Enter a valid share amount you actually hold.", "error");
    return;
  }
  busy = true;
  renderWithdrawPanel();
  try {
    const { txid } = await requestWithdrawal(address, shares);
    if (!txid) throw new Error("no txid returned — the request may have been rejected in your wallet");
    setStatus(`Broadcast: ${txid} — confirming, this can take a few minutes…`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") {
      const id = parseOkUintRepr(outcome.repr);
      if (id !== null) {
        rememberWithdrawalId(address, id);
        draftWithdrawShares = "";
        setStatus(`Withdrawal #${id} requested and confirmed: ${txid}`, "success");
      } else {
        setStatus("Withdrawal request confirmed, but its id could not be read automatically — use the lookup field once you know it.", "error");
      }
    } else {
      setStatus(`Withdrawal request did not succeed: ${outcome.status}${outcome.repr ? ` — ${outcome.repr}` : ""}`, "error");
    }
  } catch (err) {
    setStatus(`Withdrawal request failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function onClaim(id: number): Promise<void> {
  busy = true;
  renderWithdrawPanel();
  try {
    const { txid } = await claimWithdrawal(id);
    if (!txid) throw new Error("no txid returned — the request may have been rejected in your wallet");
    setStatus(`Broadcast: ${txid} — confirming, this can take a few minutes…`, "info");
    const outcome = await waitForTx(txid);
    if (outcome.status === "success") setStatus(`Withdrawal #${id} claimed: ${txid}`, "success");
    else setStatus(`Claim did not succeed: ${outcome.status}${outcome.repr ? ` — ${outcome.repr}` : ""}`, "error");
  } catch (err) {
    setStatus(`Claim failed: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    await refreshAll();
  }
}

async function onLookup(): Promise<void> {
  const input = document.getElementById("lookup-id") as HTMLInputElement;
  const id = Number(input.value);
  if (!(id >= 0)) return;
  lookupResult = (await readWithdrawalRequest(id)) ?? "not-found";
  renderLookupResult();
}

function renderLookupResult(): void {
  const el = document.getElementById("lookup-result");
  if (!el) return;
  if (lookupResult === null) {
    el.innerHTML = "";
  } else if (lookupResult === "not-found") {
    el.innerHTML = `<p class="notice">No withdrawal request with that id.</p>`;
  } else {
    const w = lookupResult;
    const remaining = blockHeight !== null ? Math.max(0, w.claimableAt - blockHeight) : null;
    el.innerHTML = `<p class="notice">Owner ${shortAddr(w.owner)} · ${fmt(w.lockedStxAmount, 6)} STX · ${w.claimed ? "claimed" : remaining === 0 ? "claimable now" : `claimable in ${remaining !== null ? blocksToEta(remaining) : "…"}`}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function renderAll(): void {
  renderStatusBanner();
  renderWalletArea();
  renderVaultStats();
  renderConsentGate();
  renderDepositPanel();
  renderPositionPanel();
  renderWithdrawPanel();
}

async function init(): Promise<void> {
  if (address) {
    const net = await verifyMainnet();
    networkOk = net.ok;
  }
  renderAll();
  await refreshAll();
  // Light polling so a pending withdrawal's countdown and vault stats stay current without a
  // manual refresh — debounced to once a minute, well under any rate limit.
  setInterval(refreshAll, 60_000);
}

init();
