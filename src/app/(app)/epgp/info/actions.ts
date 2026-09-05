"use server";

import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { updateInfoSection } from "@/lib/epgp/info-sections";
import { getSession } from "@/lib/session";

export type UpdateInfoSectionResult = { error?: string };

// Leader request, 2026-09-05: the cycle/rules info page's text sections are
// "editable by the officers and leader and admin, but not editable by the
// members" — same bar as the rest of /epgp (canManageEpgp), not the
// stricter canManageEpgpConfig the numeric settings use, since this is
// prose about the rules, not the rules themselves.
export async function updateInfoSectionAction(key: string, title: string, body: string): Promise<UpdateInfoSectionResult> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can edit this." };
  }
  if (!title.trim()) return { error: "Title is required." };

  const db = await getDb();
  await updateInfoSection(db, key, { title: title.trim(), body }, session.user.id);
  return {};
}
