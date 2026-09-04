import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { SettingRow, type SettingHistoryEntry } from "@/components/epgp/SettingRow";
import { PageHeader } from "@/components/shell/PageHeader";
import { epgpSettings, users } from "@/db";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { DEFAULT_SETTINGS, getSettingsAt, SETTING_KEYS, type SettingKey } from "@/lib/epgp/settings";
import { getSession } from "@/lib/session";

const SETTING_META: Record<SettingKey, { label: string; description: string }> = {
  ep_decay: {
    label: "EP decay rate",
    description:
      "Only used by the legacy decay model (§1a: fraction of pre-cycle EP dropped each cycle, derived at read time). Ignored under the global model — enter the global cycle-decay rate on the EPGP Decay page instead.",
  },
  gp_decay: {
    label: "GP decay rate",
    description:
      "Only used by the legacy decay model (§1a: fraction of pre-cycle GP dropped each cycle, derived at read time). Ignored under the global model — enter the global cycle-decay rate on the EPGP Decay page instead.",
  },
  base_ep: {
    label: "Base EP",
    description:
      "Two roles, neither of them a floor decay stops at: (1) added to EP in the priority ratio, (ep + base_ep) / (gp + base_gp), so a zero balance never divides by zero; (2) legacy cycle decay (§1a) is skipped entirely for a character whose lifetime raw EP is still below this. A larger balance decays straight through it — expansion decay ignores it too.",
  },
  base_gp: {
    label: "Base GP",
    description:
      "Two roles, neither a floor: (1) added to GP in the priority ratio, (ep + base_ep) / (gp + base_gp); (2) legacy cycle decay (§1a) is skipped for a character whose lifetime raw GP is below this. Decay is not clamped to stay above it.",
  },
  ep_cap_per_cycle: { label: "EP cap per cycle", description: "Maximum EP a single character can earn in one cycle (§2)." },
  min_attendance: { label: "Minimum attendance", description: "Guild members required for an attendance capture to award EP (§4h). Not yet enforced — Phase 4." },
  decay_model: {
    label: "Decay model",
    description:
      "global (current) = totals are the stored ledger rows as-is; run cycle decay on the EPGP Decay page and it lands as real negative rows (§1c). legacy = the old 20% pre-cycle haircut derived at read time, never stored — retired at cutover, kept only so pre-cutover history still reads correctly.",
  },
};

export default async function EpgpSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) redirect("/roster");

  const db = await getDb();
  const current = await getSettingsAt(db, new Date());

  const historyRows = await db
    .select({
      settingKey: epgpSettings.settingKey,
      value: epgpSettings.value,
      effectiveFrom: epgpSettings.effectiveFrom,
      changedAt: epgpSettings.changedAt,
      note: epgpSettings.note,
      changedByName: users.username,
    })
    .from(epgpSettings)
    .leftJoin(users, eq(epgpSettings.changedBy, users.id))
    .orderBy(desc(epgpSettings.effectiveFrom));

  const historyByKey = new Map<string, SettingHistoryEntry[]>();
  for (const row of historyRows) {
    const entry: SettingHistoryEntry = {
      value: row.value,
      effectiveFrom: row.effectiveFrom.toLocaleDateString(),
      changedByName: row.changedByName,
      changedAt: row.changedAt.toLocaleString(),
      note: row.note,
    };
    if (!historyByKey.has(row.settingKey)) historyByKey.set(row.settingKey, []);
    historyByKey.get(row.settingKey)!.push(entry);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="EPGP Settings"
        subtitle="Leader-tunable constants. The website is the source of truth (§4i) — the officer app fetches these at startup, it never hardcodes them. Every change is kept, never overwritten."
      />

      <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
        {SETTING_KEYS.map((key) => {
          const raw = current[key] ?? DEFAULT_SETTINGS[key];
          // The two decay-rate settings display to 2 dp (0.10, not 0.1);
          // the rest are integers or the decay_model string, shown as-is.
          const display = key === "ep_decay" || key === "gp_decay" ? Number(raw).toFixed(2) : raw;
          return (
            <SettingRow
              key={key}
              settingKey={key}
              label={SETTING_META[key].label}
              description={SETTING_META[key].description}
              currentValue={display}
              isDecayModel={key === "decay_model"}
              history={historyByKey.get(key) ?? []}
            />
          );
        })}
      </ul>
    </div>
  );
}
