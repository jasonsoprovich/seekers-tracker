import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { redirect } from "next/navigation";

import { DepartureWipeForm } from "@/components/epgp/DepartureWipeForm";
import { ExpansionDecayForm } from "@/components/epgp/ExpansionDecayForm";
import { AutoCycleDecayToggle } from "@/components/epgp/AutoCycleDecayToggle";
import { GlobalCycleDecayForm } from "@/components/epgp/GlobalCycleDecayForm";
import { ReverseDecayButton } from "@/components/epgp/ReverseDecayButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { cycles, decayEvents, epLedger, gpLedger, users } from "@/db";
import { autoCycleDecayRate, isAutoCycleDecayOn } from "@/lib/epgp/auto-cycle-decay";
import { getCurrentCycleWindow, scheduledCycleEnd } from "@/lib/epgp/cycles";
import { getDb } from "@/lib/db";
import { ledgerDate } from "@/lib/format-date";
import { guildDate, guildDateTime } from "@/lib/guild-timezone";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";

export default async function EpgpDecayPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.decay")) redirect("/roster");

  const db = await getDb();
  const appliedByUsers = alias(users, "applied_by_user");
  const reversedByUsers = alias(users, "reversed_by_user");

  const [events, epCounts, gpCounts, startedCycles, currentCycle, autoOn, autoRate] = await Promise.all([
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
    db
      .select({ decayEventId: cycles.startedByDecayEventId, cycleNumber: cycles.cycleNumber })
      .from(cycles)
      .where(sql`${cycles.startedByDecayEventId} is not null`),
    getCurrentCycleWindow(db),
    isAutoCycleDecayOn(db),
    autoCycleDecayRate(db),
  ]);
  const nextEnd = currentCycle ? scheduledCycleEnd(currentCycle) : null;
  const cycleStartedByEvent = new Map(startedCycles.map((r) => [r.decayEventId, r.cycleNumber]));

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
        <h2 className="text-lg font-semibold">Cycle decay (global model)</h2>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border px-4 py-3">
          <div className="text-sm">
            <p className="font-medium">
              Automatic cycle decay: <span className={autoOn ? "text-emerald-400" : "text-amber-300"}>{autoOn ? "on" : "off"}</span>
            </p>
            {autoOn && currentCycle && nextEnd ? (
              <p className="mt-1 text-neutral-400">
                Cycle #{currentCycle.cycle.cycleNumber} ends at midnight Eastern after {guildDate(new Date(`${nextEnd.lastDay}T12:00:00Z`), "UTC")}. Cycle
                decay runs then at {(autoRate * 100).toFixed(0)}% (the rate of the last cycle decay) and cycle #{currentCycle.cycle.cycleNumber + 1}{" "}
                starts. Cycles are two weeks, Sunday to Saturday.
              </p>
            ) : (
              <p className="mt-1 text-neutral-400">
                {nextEnd ? `The current cycle is due to end at midnight Eastern after ${guildDate(new Date(`${nextEnd.lastDay}T12:00:00Z`), "UTC")}. ` : ""}
                Run cycle decay below by hand at each cycle end.
              </p>
            )}
          </div>
          <AutoCycleDecayToggle on={autoOn} />
        </div>
        <p className="mt-3 text-sm text-neutral-400">
          Manual run: 10% against every character&apos;s current total, EP and GP, compounding cycle over cycle (§1c). Committing it also ends the
          running cycle and starts the next one. With automatic decay on you don&apos;t need this; it&apos;s here for a missed or redone decay
          (reverse the automatic one first).
        </p>
        <div className="mt-3">
          <GlobalCycleDecayForm
            currentCycle={currentCycle ? { number: currentCycle.cycle.cycleNumber, startedLabel: guildDate(currentCycle.start) } : null}
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Inactivity EP wipe</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Zeroes EP only — GP is never touched (§1e). Search by name or by an inactivity cutoff date. Confirmed with the leader (§1f): every
          character is treated the same, active or long-departed.
        </p>
        <div className="mt-3">
          <DepartureWipeForm />
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
                  effective {ledgerDate(event.effectiveDate)} — {epCountByEvent.get(event.id) ?? 0} EP row(s),{" "}
                  {gpCountByEvent.get(event.id) ?? 0} GP row(s)
                  {event.label && <span> — &ldquo;{event.label}&rdquo;</span>}
                  {cycleStartedByEvent.has(event.id) && <span> — started cycle #{cycleStartedByEvent.get(event.id)}</span>}
                </p>
                <p className="text-xs text-neutral-600">
                  applied {event.appliedByName ?? "sheet import"} on {guildDateTime(event.appliedAt)}
                  {event.reversedAt && (
                    <>
                      {" "}
                      · reversed {event.reversedByName ?? "unknown"} on {guildDateTime(event.reversedAt)}
                    </>
                  )}
                </p>
              </div>
              {!event.reversedAt && (
                <ReverseDecayButton
                  decayEventId={event.id}
                  label={`${event.kind} decay effective ${ledgerDate(event.effectiveDate)}`}
                  reopensCycle={cycleStartedByEvent.get(event.id) ?? null}
                />
              )}
            </li>
          ))}
          {events.length === 0 && <li className="px-4 py-3 text-sm text-neutral-500">No decay events yet.</li>}
        </ul>
      </section>
    </div>
  );
}
