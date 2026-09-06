"use server";

import { redirect } from "next/navigation";

import { canManageEpgp, canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { reverseRaid, setRaidMeta } from "@/lib/epgp/raids";
import { getSession } from "@/lib/session";

export type RaidMetaResult = { error?: string };
export type ReverseRaidActionResult = { ok?: true; epRows?: number; gpRows?: number; lootEvents?: number; bids?: number; error?: string };

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

// Leader/admin only (canManageEpgpConfig) — a raid reverse deletes ledger
// rows in bulk, the same destructive bar as /epgp/decay's reverse button, a
// step above the officer-level "name this raid" action above. Wraps
// reverseRaid; see its comment for exactly what gets deleted and kept.
export async function reverseRaidAction(raidDate: string): Promise<ReverseRaidActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) {
    return { error: "Only leaders and admins can reverse a raid." };
  }

  const db = await getDb();
  const result = await reverseRaid(db, raidDate, session.user.id);
  if ("error" in result) return { error: result.error };
  return result;
}
