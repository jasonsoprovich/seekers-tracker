import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createAuth } from "@/auth";
import { canManageEpgp, getUserRole } from "@/lib/authz";

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

export async function requireOfficerApiKey(request: Request): Promise<OfficerApiAuth> {
  const key = request.headers.get("x-api-key");
  if (!key) return { error: "Missing x-api-key header.", status: 401 };

  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);

  const result = await auth.api.verifyApiKey({ body: { key, permissions: EPGP_WRITE_PERMISSION } });
  if (!result.valid || !result.key) {
    return { error: "Invalid or expired API key.", status: 401 };
  }

  const role = await getUserRole(result.key.referenceId);
  if (!canManageEpgp(role)) {
    return { error: "This key's owner is no longer an officer, leader, or admin.", status: 403 };
  }

  return { userId: result.key.referenceId };
}
