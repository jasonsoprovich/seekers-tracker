import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { InfoSectionEditor } from "@/components/epgp/InfoSectionEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { epgpPointValues } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getCurrentCycle } from "@/lib/epgp/cycles";
import { ledgerDate } from "@/lib/format-date";
import { getDb } from "@/lib/db";
import { listInfoSections } from "@/lib/epgp/info-sections";
import { getSettingsAt } from "@/lib/epgp/settings";
import { getSession } from "@/lib/session";

// Member-facing reference for everything the guild's old spreadsheet had a
// tab for — cycle state, EP cap/decay, priority formula, point values —
// but as the website's own live source, not a snapshot someone forgot to
// update. The numeric facts here are read straight from epgp_settings /
// cycles (the same rows the admin panel edits — this page never
// duplicates them); only the prose sections (InfoSectionEditor) are their
// own stored text, editable by officer+ (leader request, 2026-09-05:
// "should link and show correct info from the officer admin panel...
// text related sections should be editable by the officers and leader and
// admin, but not editable by the members").
export default async function EpgpInfoPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const role = await getUserRole(session.user.id);
  const canEdit = canManageEpgp(role);

  const [settings, currentCycle, pointValues, sections] = await Promise.all([
    getSettingsAt(db),
    getCurrentCycle(db),
    db
      .select({ kind: epgpPointValues.kind, activity: epgpPointValues.activity, points: epgpPointValues.points })
      .from(epgpPointValues)
      .where(eq(epgpPointValues.retired, false))
      .orderBy(asc(epgpPointValues.sortOrder)),
    listInfoSections(db),
  ]);

  const epValues = pointValues.filter((v) => v.kind === "ep");
  const gpValues = pointValues.filter((v) => v.kind === "gp");
  const decayModel = settings.decay_model === "global" ? "Global cycle decay (compounding)" : "Legacy cycle decay (pre-cycle only)";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Cycle & Rules Info" subtitle="Where the numbers come from, and the rules behind them." />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-border p-4">
          <h2 className="text-base font-semibold">Current Cycle</h2>
          {currentCycle ? (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-neutral-400">Cycle</dt>
                <dd className="font-medium">#{currentCycle.cycleNumber}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-400">Starts</dt>
                <dd className="font-medium">{ledgerDate(currentCycle.startDate)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-400">Ends</dt>
                <dd className="font-medium">{ledgerDate(currentCycle.endDate)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">No cycle is currently scheduled.</p>
          )}
        </section>

        <section className="rounded-lg border border-border p-4">
          <h2 className="text-base font-semibold">EP Cap &amp; Decay</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-neutral-400">EP cap per cycle</dt>
              <dd className="font-medium">{settings.ep_cap_per_cycle ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">EP decay rate</dt>
              <dd className="font-medium">{settings.ep_decay ? `${(Number(settings.ep_decay) * 100).toFixed(0)}%` : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">GP decay rate</dt>
              <dd className="font-medium">{settings.gp_decay ? `${(Number(settings.gp_decay) * 100).toFixed(0)}%` : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">Decay model</dt>
              <dd className="font-medium">{decayModel}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">Base EP / GP</dt>
              <dd className="font-medium">
                {settings.base_ep ?? "—"} / {settings.base_gp ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">Minimum attendance</dt>
              <dd className="font-medium">{settings.min_attendance ?? "—"}</dd>
            </div>
          </dl>
          {canEdit && (
            <p className="mt-3 text-xs text-neutral-500">
              These come straight from{" "}
              <a href="/epgp/settings" className="text-emerald-400 hover:text-emerald-300">
                EPGP Settings
              </a>{" "}
              — change them there, not here.
            </p>
          )}
        </section>
      </div>

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-base font-semibold">Point Values</h2>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">EP Activities</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {epValues.map((v) => (
                <li key={v.activity} className="flex justify-between">
                  <span className="text-neutral-300">{v.activity}</span>
                  <span className="font-mono tabular-nums text-emerald-400">{v.points}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">GP Tiers</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {gpValues.map((v) => (
                <li key={v.activity} className="flex justify-between">
                  <span className="text-neutral-300">{v.activity}</span>
                  <span className="font-mono tabular-nums text-emerald-400">{v.points}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <div className="mt-4 space-y-4">
        {sections.map((s) => (
          <InfoSectionEditor key={s.key} sectionKey={s.key} title={s.title} body={s.body} canEdit={canEdit} />
        ))}
      </div>
    </div>
  );
}
