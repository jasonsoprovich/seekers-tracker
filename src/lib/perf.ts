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

// Always-on hang detector (2026-09-11), independent of PERF_DEBUG: a stage
// still pending after STAGE_HANG_MS logs `[hang] stage <label>` WHILE it
// is stuck — the request may never finish (Workers Logs showed renders
// held 40s–100min then "canceled" with no log lines), so logging only on
// completion would show nothing. See src/lib/d1-watchdog.ts for the
// statement-level equivalent.
const STAGE_HANG_MS = 10_000;

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const timer = setTimeout(() => console.warn(`[hang] stage ${label} still running after ${STAGE_HANG_MS}ms`), STAGE_HANG_MS);
  let threw = false;
  try {
    return await fn();
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (perfEnabled()) console.log(`[perf] ${label} ${ms}ms${threw ? " (threw)" : ""}`);
    else if (ms >= STAGE_HANG_MS) console.warn(`[hang] stage ${label} finished after ${ms}ms${threw ? " (threw)" : ""}`);
  }
}

// Fire-and-forget note in the tail, e.g. "getSession -> null".
export function perfNote(msg: string): void {
  if (perfEnabled()) console.log(`[perf] ${msg}`);
}
