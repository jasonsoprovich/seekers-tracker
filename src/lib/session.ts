import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { cache } from "react";

import { createAuth } from "@/auth";
import { perfNote, timed } from "@/lib/perf";

// Server-side session lookup (RSC / server actions). Rebuilds `auth` from
// the request's Cloudflare context each call, matching the API route
// handler (src/app/api/auth/[...all]/route.ts) — the module-level `auth`
// export has no D1 binding outside a request.
//
// Wrapped in React's cache() so every layout/page/action that calls this
// during one request shares a single D1 round-trip instead of each issuing
// its own — this function is called from ~30 call sites, several of them
// (layout + page) on the same navigation.
//
// Retry (post-live-test-1 LT-26): a cold Worker isolate plus a slow first
// D1 read was enough for better-auth's lookup to throw (or come back empty)
// and for the caller to redirect(/login) — the "had to reauthenticate and
// then it worked" symptom. When the request carries an auth cookie, that
// null/throw is far more likely a transient infra blip than a real logout,
// so retry a couple times before giving up. No auth cookie → genuinely not
// logged in, no retry. Costs nothing on the normal path (first try wins).
//
// Bounded failure path (remediation plan Phase 0.5, 2026-09-12): everything
// above is a *soft* signal — timed()'s "[hang] stage ... still running"
// warnings fire but never stop the await, so a genuinely stalled
// auth.$context/auth.api.getSession() call used to hang until custom-
// worker.ts's outer 25s request/body deadline eventually killed the whole
// response. Layout.tsx's only reaction to a falsy getSession() result is
// `redirect("/login")` — which is correct for "no session" but WRONG for
// "the lookup never came back": that would present a stalled server as a
// logout. SESSION_LOOKUP_DEADLINE_MS below races the whole authContext +
// getSession sequence against a hard timeout that THROWS (a
// SessionLookupTimeoutError), not one that resolves null — an uncaught
// throw from a Server Component/action propagates to the nearest error
// boundary ((app)/error.tsx, or global-error.tsx for the layout itself),
// which already renders a "Reload / Try again" card, instead of ever
// reaching the redirect-to-/login line. Comfortably shorter than
// custom-worker.ts's 25s outer deadline so this fires first and gives a
// specific, correct signal instead of a generic request-timeout page.
export class SessionLookupTimeoutError extends Error {
  constructor(ms: number) {
    super(`Session lookup timed out after ${ms}ms — a stalled check, not a logout`);
    this.name = "SessionLookupTimeoutError";
  }
}

const SESSION_LOOKUP_DEADLINE_MS = 12_000;

export const getSession = cache(async function getSession() {
  const { env, cf } = await timed("cfContext", () => getCloudflareContext({ async: true }));
  const auth = createAuth(env, cf);
  const hdrs = await headers();
  const hasAuthCookie = (hdrs.get("cookie") ?? "").includes("better-auth.session");

  // See custom-worker.ts's REQUEST_ID_HEADER comment — folds this request's
  // id into every stage label below so Workers Logs shows one request's
  // timeline instead of several interleaved ones. Falls back to "-" for a
  // caller with no request context (there shouldn't be one in production;
  // defensive only).
  const reqId = hdrs.get("x-request-id") ?? "-";

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new SessionLookupTimeoutError(SESSION_LOOKUP_DEADLINE_MS)), SESSION_LOOKUP_DEADLINE_MS);
  });

  const lookup = async () => {
    // Split out as its own stage (2026-09-12): every `auth.api.*` call first
    // awaits the instance's shared init promise (better-auth `$context`).
    // Workers Logs on 09-11/09-12 showed getSession hanging for minutes with
    // NO D1 statement pending — so the stuck await is upstream of the DB,
    // and this names whether it's the init promise or the endpoint itself.
    await timed(`[${reqId}] authContext`, () => auth.$context.then(() => undefined));

    return timed(`[${reqId}] getSession`, async () => {
      const maxAttempts = hasAuthCookie ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const session = await auth.api.getSession({ headers: hdrs });
          if (session || attempt === maxAttempts) {
            if (!session && hasAuthCookie) {
              // Always log this one (not perfNote / PERF_DEBUG-gated): a
              // request that arrives WITH an auth cookie but resolves to no
              // session after every retry is the "keeps deauthing" loop, and
              // it needs to be visible in `wrangler tail` in normal operation
              // without a redeploy to flip PERF_DEBUG. Failure path only, so
              // it stays silent when things are healthy.
              console.warn(
                `[auth] [${reqId}] getSession -> null despite an auth cookie after retries; redirecting to /login`,
              );
            }
            return session;
          }
        } catch (e) {
          perfNote(`[${reqId}] getSession threw on attempt ${attempt}/${maxAttempts}: ${e}`);
          if (attempt === maxAttempts) return null;
        }
        await new Promise((r) => setTimeout(r, 120 * attempt));
      }
      return null;
    });
  };

  try {
    return await Promise.race([lookup(), deadline]);
  } catch (e) {
    if (e instanceof SessionLookupTimeoutError) {
      console.error(`[auth] [${reqId}] ${e.message}`);
    }
    throw e;
  } finally {
    clearTimeout(deadlineTimer);
  }
});
