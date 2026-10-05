// The vault contract has no index of "withdrawal ids belonging to address X" — next-withdrawal-id
// is a single global counter, not per-depositor (see contracts/deepstack-vault.clar). Without a
// backend/indexer, this app can only remember ids IT witnessed being created, per connecting
// browser. This is a real, disclosed limitation, not hidden: the UI also offers a manual
// "check a withdrawal by id" lookup (the id is public on-chain either way) as a fallback for a
// cleared cache or a different device — see the app's own README.

const STORAGE_KEY = "deepstack-known-withdrawals-v1";

type Store = Record<string, number[]>; // address -> withdrawal ids

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort only — never block the UI on a storage failure
  }
}

export function rememberWithdrawalId(address: string, id: number): void {
  const store = load();
  const ids = new Set(store[address] ?? []);
  ids.add(id);
  store[address] = [...ids].sort((a, b) => a - b);
  save(store);
}

export function getKnownWithdrawalIds(address: string): number[] {
  return load()[address] ?? [];
}
