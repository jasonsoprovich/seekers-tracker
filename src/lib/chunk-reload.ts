// Deploy-skew recovery. A tab that was open across a redeploy is still
// running the previous build; the moment it tries to lazy-load a route
// chunk that no longer exists on the edge it throws — and Next's client
// router has no recovery path, so navigation just wedges ("the site froze
// overnight"). The error boundaries (src/app/global-error.tsx,
// src/app/(app)/error.tsx) call handleChunkLoadError() to turn that into a
// single automatic reload onto the current build.

const RELOAD_GUARD_KEY = "seekers:chunk-reload";

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /Loading (?:CSS )?chunk [\w-]+ failed/i.test(error.message) ||
    /Failed to fetch dynamically imported module/i.test(error.message) ||
    /error loading dynamically imported module/i.test(error.message)
  );
}

// Returns true if it kicked off a reload (caller should render a "reloading"
// state or nothing). The sessionStorage flag stops a reload loop when the
// new build still throws — that's a real bug, not staleness, and should
// surface the error UI instead.
export function handleChunkLoadError(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  let alreadyTried = false;
  try {
    alreadyTried = window.sessionStorage.getItem(RELOAD_GUARD_KEY) === "1";
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
  } catch {
    // sessionStorage blocked (private mode, etc.) — best-effort: reload once.
  }
  if (alreadyTried) return false;
  window.location.reload();
  return true;
}

// Call once the app has rendered successfully, so the next stale-chunk
// event is allowed its one reload again.
export function clearChunkReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // ignore
  }
}
