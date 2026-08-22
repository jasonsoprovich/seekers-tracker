import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { redirect } from "next/navigation";

import { ExpansionDecayForm } from "@/components/epgp/ExpansionDecayForm";
import { ReverseDecayButton } from "@/components/epgp/ReverseDecayButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { decayEvents, epLedger, gpLedger, users } from "@/db";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export default async function EpgpDecayPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) redirect("/roster");

  const db = await getDb();
  const appliedByUsers = alias(users, "applied_by_user");
  const reversedByUsers = alias(users, "reversed_by_user");

  const [events, epCounts, gpCounts] = await Promise.all([
    db
      .select({
        id: decayEvents.id,
        kind: decayEvents.kind,
        epRate: decayEvents.epRate,
        gpRate: decayEvents.gpRate,
        effectiveDate: decayEvents.effectiveDate,
        label: decayEvents.label,
        appliedAt: decayEvents.appliedAt,
        appliedByName: appliedByUsers.username,
        reversedAt: decayEvents.reversedAt,
        reversedByName: reversedByUsers.username,
      })
      .from(decayEvents)
      .leftJoin(appliedByUsers, eq(decayEvents.appliedBy, appliedByUsers.id))
      .leftJoin(reversedByUsers, eq(decayEvents.reversedBy, reversedByUsers.id))
      .orderBy(desc(decayEvents.effectiveDate)),
    db
      .select({ decayEventId: epLedger.decayEventId, count: sql<number>`count(*)` })
      .from(epLedger)
      .where(sql`${epLedger.decayEventId} is not null`)
      .groupBy(epLedger.decayEventId),
    db
      .select({ decayEventId: gpLedger.decayEventId, count: sql<number>`count(*)` })
      .from(gpLedger)
      .where(sql`${gpLedger.decayEventId} is not null`)
      .groupBy(gpLedger.decayEventId),
  ]);

  const epCountByEvent = new Map(epCounts.map((r) => [r.decayEventId, r.count]));
  const gpCountByEvent = new Map(gpCounts.map((r) => [r.decayEventId, r.count]));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="EPGP Decay"
        subtitle="Run and undo decay batches — every mechanism except legacy pre-cutover cycle decay (§1a), which stays derived and never appears here."
      />

      <section>
        <h2 className="text-lg font-semibold">Expansion decay</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Applies to every character&apos;s current EP and GP balance (PLAN.md §1b). Preview before committing — a commit writes ledger rows
          immediately.
        </p>
        <div className="mt-3">
          <ExpansionDecayForm />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Decay history</h2>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">
                  {event.kind} — {event.epRate !== null ? `${(event.epRate * 100).toFixed(0)}% EP` : null}
                  {event.epRate !== null && event.gpRate !== null ? ", " : ""}
                  {event.gpRate !== null ? `${(event.gpRate * 100).toFixed(0)}% GP` : null}
                  {event.reversedAt && <span className="ml-2 text-xs text-red-400">reversed</span>}
                </p>
                <p className="text-sm text-neutral-500">
                  effective {event.effectiveDate.toLocaleDateString()} — {epCountByEvent.get(event.id) ?? 0} EP row(s),{" "}
                  {gpCountByEvent.get(event.id) ?? 0} GP row(s)
                  {event.label && <span> — &ldquo;{event.label}&rdquo;</span>}
                </p>
                <p className="text-xs text-neutral-600">
                  applied {event.appliedByName ?? "sheet import"} on {event.appliedAt.toLocaleString()}
                  {event.reversedAt && (
                    <>
                      {" "}
                      · reversed {event.reversedByName ?? "unknown"} on {event.reversedAt.toLocaleString()}
                    </>
                  )}
                </p>
              </div>
              {!event.reversedAt && (
                <ReverseDecayButton decayEventId={event.id} label={`${event.kind} decay effective ${event.effectiveDate.toLocaleDateString()}`} />
              )}
            </li>
          ))}
          {events.length === 0 && <li className="px-4 py-3 text-sm text-neutral-500">No decay events yet.</li>}
        </ul>
      </section>
    </div>
  );
}
