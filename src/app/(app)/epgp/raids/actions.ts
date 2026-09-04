"use server";

import { redirect } from "next/navigation";

import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { setRaidMeta } from "@/lib/epgp/raids";
import { getSession } from "@/lib/session";

export type RaidMetaResult = { error?: string };

// Officer+ names/annotates a raid night. The date is the identity (from the
// URL), so there's no create/delete — just an upsert of the label.
export async function updateRaidMeta(raidDate: string, name: string, note: string): Promise<RaidMetaResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can name a raid." };
  }

  const db = await getDb();
  try {
    await setRaidMeta(db, raidDate, name.trim() || null, note.trim() || null, session.user.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't save." };
  }
  return {};
}
