// Shared HTTP plumbing for every Hiro API call (reads.ts, tx.ts): API key, a timeout per
// request, retry with jittered backoff, and a small cap on concurrent requests.
//
// Why each piece exists (all observed live, 2026-10-06/07):
// - Hiro intermittently answers "503 upstream connect error" after up to ~10s, and those
//   error responses carry no Access-Control-Allow-Origin header. The browser therefore
//   reports them as a CORS failure ("blocked by CORS policy") and the app never sees the
//   503 itself. The timeout turns a slow hang into a fast retry, and the retry absorbs the
//   intermittent failure.
// - Unauthenticated callers get 50 requests/min and 20/s per IP. The concurrency cap keeps a
//   full refresh from arriving as one burst.

import { HIRO_API_KEY, READ_TIMEOUT_MS } from "./config";

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// Always returns a NEW wrapper function, never the bare native `fetch` reference.
// fetchCallReadOnlyFunction invokes it as `client.fetch(url, init)`, a method call, and
// native fetch throws "Illegal invocation" when its `this` isn't the window (caught live,
// 2026-10-06; typecheck/build can't catch it).
export function hiroFetch(): typeof fetch {
  const key = HIRO_API_KEY;
  return ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = key ? { ...(init?.headers as Record<string, string> | undefined), "x-api-key": key } : init?.headers;
    return fetch(url, { ...init, headers, signal: init?.signal ?? timeoutSignal(READ_TIMEOUT_MS) });
  }) as typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Jittered so a batch of failed reads doesn't retry in lockstep.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(800 + Math.random() * 1200 * (i + 1));
    }
  }
  throw lastErr;
}

const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((resolve) => waiting.push(resolve)); // the releaser hands its slot over
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

// One HTTP attempt per slot. Backoff sleeps happen OUTSIDE the slot, so a waiting retry never
// blocks other requests.
export function hiroCall<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(() => withSlot(fn));
}

export async function hiroGetJson(base: string, path: string): Promise<any> {
  return hiroCall(async () => {
    const res = await hiroFetch()(`${base}${path}`);
    if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
    return res.json();
  });
}
