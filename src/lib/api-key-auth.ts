import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { createAuth } from "@/auth";
import * as schema from "@/db";
import { users } from "@/db";
import { canManageEpgp, type Role } from "@/lib/authz";

// Auth for /api/officer/* routes, called by the standalone EPGP parser app
// (seekers-epgp-parser) instead of a browser session. Deliberately does its
// own auth.api.verifyApiKey call rather than the plugin's
// `enableSessionForAPIKeys` shortcut — that option mocks a full site
// session for any request bearing a valid key, which would let a leaked
// key act as that officer on every page and server action, not just these
// two narrow routes. Verifying explicitly, per-route, keeps a key's power
// scoped to exactly what it's for.
export type OfficerApiAuth = { userId: string } | { error: string; status: number };

const EPGP_WRITE_PERMISSION = { epgp: ["write"] };

// Entry point for Next route handlers — resolves the Cloudflare context
// itself, then defers to verifyOfficerApiKey.
export async function requireOfficerApiKey(request: Request): Promise<OfficerApiAuth> {
  const { env, cf } = await getCloudflareContext({ async: true });
  return verifyOfficerApiKey(request, env, cf);
}

// Same check, but with the Cloudflare context passed in — so it can also
// run from custom-worker.ts (the live-bids endpoints, PLAN.md §15), which
// is outside Next and can't call getCloudflareContext(). Everything the
// Next path used getUserRole()/getDb() for is done here off `env` directly.
export async function verifyOfficerApiKey(
  request: Request,
  env: CloudflareEnv,
  cf?: Parameters<typeof createAuth>[1],
): Promise<OfficerApiAuth> {
  const key = request.headers.get("x-api-key");
  if (!key) return { error: "Missing x-api-key header.", status: 401 };

  const auth = createAuth(env, cf);

  // @better-auth/api-key's verifyApiKey normally reports a bad key as
  // `{valid: false}`, but some conditions (a key row deleted mid-flight, an
  // internal plugin error) make it *throw* an APIError instead. Uncaught,
  // that propagates out of the custom-worker.ts live-bids handlers (which
  // have no try/catch) and, when an officer app polls a stale key every few
  // seconds, the repeated unhandled rejection has taken `wrangler dev`
  // down. Treat a throw the same as an invalid key — a bad key from any
  // officer must never be able to crash the site.
  let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
  try {
    result = await auth.api.verifyApiKey({ body: { key, permissions: EPGP_WRITE_PERMISSION } });
  } catch (err) {
    const message = err instanceof Error ? err.message : undefined;
    return { error: message ?? "Could not validate API key.", status: 401 };
  }
  if (!result.valid || !result.key) {
    // Surface the real reason (e.g. RATE_LIMITED) instead of a blanket
    // "invalid or expired" — that blanket message is what made the
    // rate-limit bug (see src/auth/index.ts) look like key expiration.
    if (result.error?.code === "RATE_LIMITED") {
      return { error: "Rate limit exceeded for this API key. Wait a moment and try again.", status: 429 };
    }
    const message = typeof result.error?.message === "string" ? result.error.message : undefined;
    return { error: message ?? "Invalid or expired API key.", status: 401 };
  }

  const db = drizzle(env.DATABASE, { schema });
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, result.key.referenceId));
  if (!canManageEpgp((row?.role ?? null) as Role | null)) {
    return { error: "This key's owner is no longer an officer, leader, or admin.", status: 403 };
  }

  return { userId: result.key.referenceId };
}
