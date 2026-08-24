// PLAN.md §11 Phase 2 task 2.3 — backfill the 3 historical expansion decays
// (§1b) that scripts/import-epgp.ts already wrote as plain "Decay"
// ep_ledger/gp_ledger rows, into the new decay_events table, and link those
// existing rows to it via decay_event_id.
//
// Idempotent: skips a date that already has an (unreversed) expansion
// decay_events row, and only links rows that don't already have a
// decay_event_id. Safe to re-run after a fresh scripts/import-epgp.ts
// re-seed — a re-import doesn't touch decay_events, so the second run just
// re-links the freshly re-imported "Decay" rows.
//
// Usage:
//   npx tsx scripts/backfill-expansion-decay.ts
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { decayEvents, epLedger, gpLedger } from "../src/db/schema";
import { findActiveRateDecayEvent } from "../src/lib/epgp/decay";

// Rates from PLAN.md §1b's verified table — "Rate (labelled in GP Loot
// column)". Dates are the effective date, midnight local-to-the-import
// timezone, matching how scripts/import-epgp.ts wrote occurred_at for
// these rows (see the ep_ledger/gp_ledger occurred_at values themselves).
const HISTORICAL_EVENTS: { effectiveDate: Date; rate: number; label: string }[] = [
  { effectiveDate: new Date("2024-07-01T00:00:00Z"), rate: 0.5, label: "Expansion decay 50% (backfilled from sheet import)" },
  { effectiveDate: new Date("2025-03-30T00:00:00Z"), rate: 0.75, label: "Expansion decay 75% (backfilled from sheet import)" },
  { effectiveDate: new Date("2025-12-30T00:00:00Z"), rate: 0.85, label: "Expansion decay 85% (backfilled from sheet import)" },
];

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    for (const { effectiveDate, rate, label } of HISTORICAL_EVENTS) {
      const existing = await findActiveRateDecayEvent(db, "expansion", effectiveDate);
      let eventId: number;
      if (existing) {
        console.log(`${effectiveDate.toDateString()}: decay_events row already exists (id ${existing.id}), reusing it.`);
        eventId = existing.id;
      } else {
        const [event] = await db
          .insert(decayEvents)
          .values({
            kind: "expansion",
            epRate: rate,
            gpRate: rate,
            effectiveDate,
            label,
            appliedBy: null,
            appliedAt: effectiveDate,
          })
          .returning();
        eventId = event.id;
        console.log(`${effectiveDate.toDateString()}: created decay_events row id ${eventId} (${rate * 100}%).`);
      }

      const epLinked = await db
        .update(epLedger)
        .set({ decayEventId: eventId })
        .where(and(eq(epLedger.activity, "Decay"), eq(epLedger.occurredAt, effectiveDate), isNull(epLedger.decayEventId)))
        .returning({ id: epLedger.id });
      const gpLinked = await db
        .update(gpLedger)
        .set({ decayEventId: eventId })
        .where(and(eq(gpLedger.tier, "Decay"), eq(gpLedger.occurredAt, effectiveDate), isNull(gpLedger.decayEventId)))
        .returning({ id: gpLedger.id });

      console.log(`  linked ${epLinked.length} EP row(s), ${gpLinked.length} GP row(s).`);
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
