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
export const getSession = cache(async function getSession() {
  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  const hdrs = await headers();
  const hasAuthCookie = (hdrs.get("cookie") ?? "").includes("better-auth.session");

  return timed("getSession", async () => {
    const maxAttempts = hasAuthCookie ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const session = await auth.api.getSession({ headers: hdrs });
        if (session || attempt === maxAttempts) {
          if (!session && hasAuthCookie) {
            perfNote("getSession -> null despite an auth cookie after retries; redirecting to /login");
          }
          return session;
        }
      } catch (e) {
        perfNote(`getSession threw on attempt ${attempt}/${maxAttempts}: ${e}`);
        if (attempt === maxAttempts) return null;
      }
      await new Promise((r) => setTimeout(r, 120 * attempt));
    }
    return null;
  });
});
