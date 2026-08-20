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
// automatically). A leader/admin view to revoke someone else's key isn't
// built yet; add it if a lost-device scenario actually needs it.
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
