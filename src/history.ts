// A crude, honest, best-effort local history of the vault's own cumulative-realized-pnl /
// high-water-mark, so the "your fee math" panel can chart a trend — no DeFi vault product
// researched for this project visualizes this at all (see reports/DeepStack vault deposit
// frontend.md), so there's no real precedent to match, and this app has no backend/indexer to
// draw a true history from. This is ONLY as complete as this one browser's own visits; it is
// NOT an authoritative record — the live, current values read straight from the contract
// (reads.ts) always take precedence and are shown alongside the chart, never replaced by it.

const STORAGE_KEY = "deepstack-vault-history-v1";
const MAX_POINTS = 200;

export interface HistoryPoint {
  t: number; // epoch ms
  pnlStx: number;
  hwmStx: number;
}

function load(): HistoryPoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HistoryPoint[]) : [];
  } catch {
    return [];
  }
}

function save(points: HistoryPoint[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(points.slice(-MAX_POINTS)));
  } catch {
    // best-effort only
  }
}

// Records at most one point per hour, so a page left open polling doesn't flood storage with
// near-duplicate points.
export function recordHistoryPoint(pnlStx: number, hwmStx: number): HistoryPoint[] {
  const points = load();
  const now = Date.now();
  const last = points[points.length - 1];
  if (!last || now - last.t > 60 * 60 * 1000) {
    points.push({ t: now, pnlStx, hwmStx });
    save(points);
  }
  return points;
}

export function getHistory(): HistoryPoint[] {
  return load();
}
