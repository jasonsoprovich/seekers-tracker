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
  ep_decay: { label: "EP decay rate", description: "Legacy cycle decay: fraction of pre-cycle EP dropped each cycle (§1a)." },
  gp_decay: { label: "GP decay rate", description: "Legacy cycle decay: fraction of pre-cycle GP dropped each cycle (§1a)." },
  base_ep: { label: "Base EP", description: "Lifetime EP floor below which decay doesn't apply at all." },
  base_gp: { label: "Base GP", description: "Lifetime GP floor below which decay doesn't apply at all." },
  ep_cap_per_cycle: { label: "EP cap per cycle", description: "Maximum EP a single character can earn in one cycle (§2)." },
  min_attendance: { label: "Minimum attendance", description: "Guild members required for an attendance capture to award EP (§4h). Not yet enforced — Phase 4." },
  decay_model: { label: "Decay model", description: "legacy = 20% derived from pre-cycle total; global = 10% compounding stored rows (§1c). Not yet wired up — Phase 5." },
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
        {SETTING_KEYS.map((key) => (
          <SettingRow
            key={key}
            settingKey={key}
            label={SETTING_META[key].label}
            description={SETTING_META[key].description}
            currentValue={current[key] ?? DEFAULT_SETTINGS[key]}
            isDecayModel={key === "decay_model"}
            history={historyByKey.get(key) ?? []}
          />
        ))}
      </ul>
    </div>
  );
}
