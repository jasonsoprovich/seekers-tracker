// Opt-in request timing for the Phase 4 performance spike (post-live-test-1
// LT-26). Completely inert unless PERF_DEBUG=1 is set on the Worker:
// custom-worker.ts reads it once per isolate and flips
// globalThis.__PERF_DEBUG__, after which every timed() call below
// console.logs a "[perf] <label> <ms>ms" line visible in `wrangler tail`.
// When it's off the cost is one boolean read per call. Safe to leave in the
// tree with PERF_DEBUG unset; flip it on for a spike, read the tail, flip
// it back.

declare global {
  // eslint-disable-next-line no-var
  var __PERF_DEBUG__: boolean | undefined;
}

const MODULE_LOADED_AT = Date.now();
let firstRequestLogged = false;

export function perfEnabled(): boolean {
  return globalThis.__PERF_DEBUG__ === true;
}

export function setPerfEnabled(on: boolean): void {
  globalThis.__PERF_DEBUG__ = on;
}

// Call once at the very top of the Worker fetch handler. The first call in a
// fresh isolate reports how long it sat between module evaluation and its
// first request — a proxy for cold-start cost.
export function markRequest(pathname: string): void {
  if (!perfEnabled() || firstRequestLogged) return;
  firstRequestLogged = true;
  console.log(`[perf] cold-start ${Date.now() - MODULE_LOADED_AT}ms from isolate load; first path ${pathname}`);
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!perfEnabled()) return fn();
  const t0 = Date.now();
  let threw = false;
  try {
    return await fn();
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    console.log(`[perf] ${label} ${Date.now() - t0}ms${threw ? " (threw)" : ""}`);
  }
}

// Fire-and-forget note in the tail, e.g. "getSession -> null".
export function perfNote(msg: string): void {
  if (perfEnabled()) console.log(`[perf] ${msg}`);
}
