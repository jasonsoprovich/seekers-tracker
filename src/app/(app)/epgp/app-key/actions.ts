"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createAuth } from "@/auth";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getSession } from "@/lib/session";

export type AppKeyActionResult = { error?: string; key?: string };

// Officer app keys are self-service — each officer manages only their own
// (auth.api.listApiKeys/deleteApiKey below scope to the caller's session
// automatically, and better-auth's api-key plugin has no server-side
// "list/delete another user's key" call for user-owned keys — confirmed
// against the plugin's own reference docs, not assumed).
//
// A leader/admin view onto every officer's key was tried (2026-09-05) and
// reverted the same day — the leader's call: seeing another member's key
// metadata (even without the secret itself) is a security surface not
// worth opening. Automatic revocation on role loss / guild removal
// (src/lib/api-key-auth.ts's revokeApiKeysForUser, called from
// admin/actions.ts) covers the actual risk instead — a departed/demoted
// officer's key stops existing at all, so there's nothing left that would
// need a leader to go find and revoke it by hand.
export async function generateAppKey(name: string): Promise<AppKeyActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can generate app keys." };
  }

  const trimmedName = name.trim();
  if (!trimmedName) return { error: 'Name your key (e.g. "Officer laptop") so you can tell it apart later.' };

  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  const created = await auth.api.createApiKey({
    body: {
      name: trimmedName,
      permissions: { epgp: ["write"] },
      userId: session.user.id,
    },
  });

  return { key: created.key };
}

export async function revokeAppKey(keyId: string): Promise<AppKeyActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can manage app keys." };
  }

  const { env, cf } = await getCloudflareContext({ async: true });
  const auth = createAuth(env, cf);
  await auth.api.deleteApiKey({
    body: { keyId },
    headers: await headers(),
  });

  return {};
}
