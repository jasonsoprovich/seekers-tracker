"use server";

import { redirect } from "next/navigation";

import { setSetting, SETTING_KEYS, type SettingKey } from "@/lib/epgp/settings";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { refreshStandings } from "@/lib/epgp/standings";

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

  // base_ep/base_gp/ep_decay/gp_decay/decay_model all feed
  // computeEpgpTotals, so a change here moves every player's priority (and,
  // under legacy, their decay). Rebuild the whole materialized table.
  await refreshStandings(db, { all: true });

  return {};
}
