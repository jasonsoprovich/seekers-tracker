import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";

import { createAuth } from "@/auth";

// Server-side session lookup (RSC / server actions). Rebuilds `auth` from
// the request's Cloudflare context each call, matching the API route
// handler (src/app/api/auth/[...all]/route.ts) — the module-level `auth`
// export has no D1 binding outside a request.
export async function getSession() {
  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  return auth.api.getSession({ headers: await headers() });
}
