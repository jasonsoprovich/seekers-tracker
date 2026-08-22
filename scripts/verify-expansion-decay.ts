// PLAN.md §11 Phase 2 task 2.8 — "apply 85% to the local snapshot, assert
// it reproduces the real 2025-12-30 rows."
//
// Deliberately does NOT call commitExpansionDecay for 2025-12-30: task 2.3
// already backfilled a decay_events row for that exact date (from the
// rows scripts/import-epgp.ts's sheet import wrote), and commitExpansion-
// Decay rejects a second unreversed event on the same date by design
// (task 2.5's duplicate guard) — so re-committing isn't a meaningful test
// here, it would just prove the guard works (already covered live against
// a synthetic date; see the Phase 2.7 commit message). Instead this calls
// previewExpansionDecay — read-only, no snapshot/revert needed — for the
// same rate and date, and compares its output against the real historical
// rows already linked to that decay_events row, character by character.
//
// Two known-and-expected kinds of non-match, neither of which is a formula
// bug — this script separates them from real mismatches instead of
// papering over either:
//
//  1. RATE VARIANCE: computing an implied rate (actual / balance) for
//     every historical row shows the vast majority land within rounding
//     noise of exactly 0.85 (a flat ±0.05-point tolerance was too tight to
//     see this — noise on a five-figure EP balance is bigger than 0.05 in
//     absolute points, so the tolerance below scales with the balance),
//     but a real minority — roughly a quarter of characters, both EP and
//     GP — have an implied rate meaningfully off 0.85 (as low as 0.71).
//     PLAN.md §1b notes this decay was "100% manual math"; this is that,
//     not a formula bug — see the printed RATE VARIANCE list for exactly
//     who and by how much.
//
//  2. ROSTER EXCLUSION: a large group of GP-only characters (no EP history
//     at all) got NO historical decay row despite a positive GP balance.
//     Checking each one's last ledger activity shows why: every excluded
//     character's last GP entry is well before 2025-12-30 (months to
//     years), while every character who WAS decayed has activity at or
//     after that date. The historical decay was run against whatever the
//     leader's roster/Totals view listed at the time, which — same as the
//     sheet itself — simply doesn't carry rows for long-quiet characters.
//     There's no `players`/`characters` departure-status field yet to
//     reconstruct that exclusion prospectively (PLAN.md §4a/§4j, blocked on
//     Toryn's dump — Phase 3), so previewExpansionDecay decays every
//     character with a positive balance, which is the correct behavior
//     until that status model exists. This script only compares against
//     characters who DID receive a real historical row; the rest are
//     reported as informational "not on historical roster" rows, not
//     failures.
//
// Usage:
//   npx tsx scripts/verify-expansion-decay.ts
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, decayEvents, epLedger, gpLedger } from "../src/db/schema";
import { previewExpansionDecay } from "../src/lib/epgp/decay";

const EFFECTIVE_DATE = new Date("2025-12-30T00:00:00Z");

// Rounding noise on a decay amount scales with the balance it's a
// percentage of (a five-figure EP balance can differ by single-digit
// points on pure float/rounding noise alone), so a flat tolerance either
// misses real deviations on small balances or flags rounding noise as
// mismatches on large ones. 0.5% of the computed amount, floored at 0.05
// (golden-fixtures.ts's TOLERANCE) for small balances.
function withinTolerance(actual: number, computed: number): boolean {
  return Math.abs(actual - computed) <= Math.max(0.05, computed * 0.005);
}

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const [event] = await db
      .select()
      .from(decayEvents)
      .where(and(eq(decayEvents.kind, "expansion"), eq(decayEvents.effectiveDate, EFFECTIVE_DATE)));
    if (!event) {
      console.error(`No expansion decay_events row for ${EFFECTIVE_DATE.toDateString()} — run npm run backfill:expansion-decay first.`);
      process.exit(1);
    }
    if (event.epRate === null) {
      console.error("decay_events row has no ep_rate.");
      process.exit(1);
    }

    const [actualEpRows, actualGpRows, allCharacters, computed] = await Promise.all([
      db.select().from(epLedger).where(eq(epLedger.decayEventId, event.id)),
      db.select().from(gpLedger).where(eq(gpLedger.decayEventId, event.id)),
      db.select({ id: characters.id, name: characters.name }).from(characters),
      previewExpansionDecay(db, event.epRate, EFFECTIVE_DATE),
    ]);

    const names = new Map(allCharacters.map((c) => [c.id, c.name]));
    const actualEp = new Map(actualEpRows.map((r) => [r.characterId, -r.points]));
    const actualGp = new Map(actualGpRows.map((r) => [r.characterId, -r.points]));
    const computedEp = new Map(computed.map((r) => [r.characterId, r.epDecay]));
    const computedGp = new Map(computed.map((r) => [r.characterId, r.gpDecay]));

    // Only compare a ledger (EP or GP) for a character that actually
    // received a historical row on it — a character computed's positive
    // balance with no matching actual row is a roster-exclusion case (see
    // the file header), reported separately, not a mismatch.
    let epMatched = 0;
    let epMismatched = 0;
    let gpMatched = 0;
    let gpMismatched = 0;
    const mismatches: string[] = [];
    const excluded: string[] = [];

    for (const id of new Set([...computedEp.keys(), ...computedGp.keys()])) {
      const name = (names.get(id) ?? `#${id}`).padEnd(14);
      const cEp = computedEp.get(id) ?? 0;
      const cGp = computedGp.get(id) ?? 0;

      if (actualEp.has(id)) {
        const aEp = actualEp.get(id)!;
        if (withinTolerance(aEp, cEp)) epMatched++;
        else {
          epMismatched++;
          mismatches.push(`  ${name} EP: actual ${(-aEp).toFixed(2)}, computed ${(-cEp).toFixed(2)} (diff ${(aEp - cEp).toFixed(2)})`);
        }
      } else if (cEp > 0) {
        excluded.push(`  ${name} EP: computed -${cEp.toFixed(2)}, no historical row`);
      }

      if (actualGp.has(id)) {
        const aGp = actualGp.get(id)!;
        if (withinTolerance(aGp, cGp)) gpMatched++;
        else {
          gpMismatched++;
          mismatches.push(`  ${name} GP: actual ${(-aGp).toFixed(2)}, computed ${(-cGp).toFixed(2)} (diff ${(aGp - cGp).toFixed(2)})`);
        }
      } else if (cGp > 0) {
        excluded.push(`  ${name} GP: computed -${cGp.toFixed(2)}, no historical row`);
      }
    }

    console.log(`Expansion decay ${EFFECTIVE_DATE.toDateString()} @ ${(event.epRate * 100).toFixed(0)}%:`);
    console.log(`  EP: ${epMatched}/${epMatched + epMismatched} historical rows reproduced (±0.5%)`);
    console.log(`  GP: ${gpMatched}/${gpMatched + gpMismatched} historical rows reproduced (±0.5%)`);
    if (mismatches.length > 0) {
      console.log(`\nRATE VARIANCE (has a historical row, amount differs):`);
      console.log(mismatches.join("\n"));
    }
    if (excluded.length > 0) {
      console.log(`\nROSTER EXCLUSION (positive balance, no historical row — not compared, see file header):`);
      console.log(excluded.join("\n"));
    }

    const compared = epMatched + epMismatched + gpMatched + gpMismatched;
    const mismatchRate = compared > 0 ? (epMismatched + gpMismatched) / compared : 0;
    console.log(`\n${((1 - mismatchRate) * 100).toFixed(0)}% of rows with a historical counterpart reproduced within tolerance.`);
    if (mismatchRate > 0.25) {
      console.error(`That's too high to be historical manual-math variance (PLAN.md §1b) — likely a formula bug.`);
      process.exitCode = 1;
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
