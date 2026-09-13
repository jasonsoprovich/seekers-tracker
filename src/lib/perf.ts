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

let asyncContextChecked = false;

// Remediation plan Phase 0.1/0.4 (2026-09-12): names which async-context
// primitive better-auth's own `@better-auth/core/async_hooks` resolved to
// in THIS isolate. "AsyncLocalStorage" is the real, per-continuation-safe
// implementation (native workerd async_hooks, or a genuine host-provided
// one). "AsyncLocalStoragePolyfill" is @better-auth/core's own last-resort
// fallback — a single shared mutable field that races under concurrent
// requests in the same isolate, matching the freeze investigation's
// signature (per-isolate, no D1 statement pending, one request's session
// state seemingly bleeding into another's). Which one loads depends on (a)
// the package's exports-map condition order for its "workerd" vs "edge"
// build (fixed in @better-auth/core 1.7.2 — see wrangler.jsonc's comment on
// the version pin) and (b) whether `nodejs_compat` is actually on at
// runtime, so `import("node:async_hooks")` / `globalThis.AsyncLocalStorage`
// resolve to something real instead of nothing. Always on (this is a
// one-time, near-zero-cost check per isolate, not a per-request cost) —
// read it in Workers Logs after any deploy touching better-auth's version
// or wrangler.jsonc's compatibility_flags.
export async function checkAsyncContextImplementation(): Promise<void> {
  if (asyncContextChecked) return;
  asyncContextChecked = true;
  try {
    const { getAsyncLocalStorage } = await import("@better-auth/core/async_hooks");
    const ALS = await getAsyncLocalStorage();
    const name = ALS?.name || "(anonymous)";
    if (name === "AsyncLocalStorage") {
      console.log(`[boot] async-context: ${name} (real, per-continuation isolation)`);
    } else {
      console.error(
        `[boot] async-context: ${name} — WARNING: not a real AsyncLocalStorage; cross-request state leak risk under concurrent load`,
      );
    }
  } catch (e) {
    console.error(`[boot] async-context: unavailable — ${e}`);
  }
}
