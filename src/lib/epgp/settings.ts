import { and, desc, eq, lte } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epgpSettings } from "@/db";

// The full set of leader-tunable EPGP constants (PLAN.md §4i). All of them
// live in this one effective-dated table from Phase 1 on, so the leader
// never has to wait for a later phase's schema change to start tuning a
// value — decay_model (Phase 5, §1c) and min_attendance (Phase 4, §4h) both
// sat here unused for a phase before their consumers existed.
export const SETTING_KEYS = ["ep_decay", "gp_decay", "base_ep", "base_gp", "ep_cap_per_cycle", "min_attendance", "decay_model"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

// Fallback values, used only when epgp_settings has no row yet for a key
// (e.g. a fresh dev DB before the seed script runs, or a key added to
// SETTING_KEYS that hasn't been seeded). Match the sheet's own values as
// observed 2026-08-18 — see scripts/import-epgp.ts, which is what actually
// seeds real effective-dated rows.
export const DEFAULT_SETTINGS: Record<SettingKey, string> = {
  ep_decay: "0.2",
  gp_decay: "0.2",
  base_ep: "150",
  base_gp: "100",
  ep_cap_per_cycle: "900",
  min_attendance: "12",
  decay_model: "legacy",
};

// Resolves the value in force for `key` at `date` — the row with the
// greatest effective_from <= date. This is what makes the mutable EP cap
// (§2) and the dual decay model (§1c) safe: a rate change applies only to
// rows written after it, because a historical row is always looked up at
// its own occurred_at, not "now". Returns null (not the default) if no row
// for that key has ever taken effect by that date — callers decide the
// fallback, since "no row yet" and "explicitly reverted to a value" aren't
// the same thing to every caller.
export async function getSettingAt(db: ReturnType<typeof drizzle>, key: string, date: Date): Promise<string | null> {
  const [row] = await db
    .select({ value: epgpSettings.value })
    .from(epgpSettings)
    .where(and(eq(epgpSettings.settingKey, key), lte(epgpSettings.effectiveFrom, date)))
    .orderBy(desc(epgpSettings.effectiveFrom))
    .limit(1);
  return row?.value ?? null;
}

// All settings in force at `date` (default now), one query for the whole
// table rather than one per key — epgp_settings is tiny (a handful of keys,
// a handful of historical rows each over the guild's lifetime), so fetching
// everything and reducing in JS is simpler than N getSettingAt calls and
// just as cheap. Missing keys fall back to DEFAULT_SETTINGS.
export async function getSettingsAt(db: ReturnType<typeof drizzle>, date: Date = new Date()): Promise<Record<string, string>> {
  const rows = await db.select().from(epgpSettings).where(lte(epgpSettings.effectiveFrom, date));
  const latest = new Map<string, { value: string; effectiveFrom: Date }>();
  for (const row of rows) {
    const existing = latest.get(row.settingKey);
    if (!existing || row.effectiveFrom > existing.effectiveFrom) {
      latest.set(row.settingKey, { value: row.value, effectiveFrom: row.effectiveFrom });
    }
  }
  const result: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const [key, { value }] of latest) result[key] = value;
  return result;
}

// The full effective-dated history for one key, newest first — powers the
// settings UI's change log (PLAN.md §4i "changes are auditable"). The table
// itself IS the audit trail here: nothing is ever updated or deleted, so
// there's no separate audit-log table the way ledger edits have one.
export async function getSettingHistory(db: ReturnType<typeof drizzle>, key: string) {
  return db.select().from(epgpSettings).where(eq(epgpSettings.settingKey, key)).orderBy(desc(epgpSettings.effectiveFrom));
}

// Writes a new effective-dated row. Never updates or deletes an existing
// one — that's what keeps history reconstructable (PLAN.md §4i).
// `effectiveFrom` defaults to now (an immediate change); a leader
// back-dating or future-dating a change is a deliberate feature, not
// something this guards against.
export async function setSetting(
  db: ReturnType<typeof drizzle>,
  key: string,
  value: string,
  changedBy: string,
  opts?: { effectiveFrom?: Date; note?: string },
): Promise<void> {
  await db.insert(epgpSettings).values({
    settingKey: key,
    value,
    effectiveFrom: opts?.effectiveFrom ?? new Date(),
    changedBy,
    note: opts?.note,
  });
}
