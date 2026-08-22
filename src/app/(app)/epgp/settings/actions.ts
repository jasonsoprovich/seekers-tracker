"use server";

import { redirect } from "next/navigation";

import { setSetting, SETTING_KEYS, type SettingKey } from "@/lib/epgp/settings";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { invalidateEpgpTotalsCache } from "@/lib/epgp/totals";

export type UpdateSettingResult = { error?: string };

// decay_model is the only non-numeric setting — everything else must parse
// as a finite number, since totals.ts (and every later phase's cap/decay
// logic) does arithmetic with these values, not string comparison.
const DECAY_MODELS = ["legacy", "global"];

export async function updateSetting(key: string, value: string, note: string): Promise<UpdateSettingResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) {
    return { error: "Only leaders can change EPGP settings." };
  }

  if (!SETTING_KEYS.includes(key as SettingKey)) {
    return { error: `Unknown setting key: ${key}` };
  }

  const trimmed = value.trim();
  if (key === "decay_model") {
    if (!DECAY_MODELS.includes(trimmed)) {
      return { error: `decay_model must be one of: ${DECAY_MODELS.join(", ")}` };
    }
  } else {
    const num = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(num)) {
      return { error: `${key} must be a number.` };
    }
  }

  const db = await getDb();
  await setSetting(db, key, trimmed, session.user.id, { note: note.trim() || undefined });

  // Settings feed computeEpgpTotals via getEpgpSettings — a stale cached
  // total after a leader just changed the EP cap or a decay rate would be
  // confusing (same reasoning as invalidating on every ledger write, §6).
  await invalidateEpgpTotalsCache();

  return {};
}
