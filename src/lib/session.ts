import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { cache } from "react";

import { createAuth } from "@/auth";

// Server-side session lookup (RSC / server actions). Rebuilds `auth` from
// the request's Cloudflare context each call, matching the API route
// handler (src/app/api/auth/[...all]/route.ts) — the module-level `auth`
// export has no D1 binding outside a request.
//
// Wrapped in React's cache() so every layout/page/action that calls this
// during one request shares a single D1 round-trip instead of each issuing
// its own — this function is called from ~30 call sites, several of them
// (layout + page) on the same navigation.
export const getSession = cache(async function getSession() {
  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  return auth.api.getSession({ headers: await headers() });
});
