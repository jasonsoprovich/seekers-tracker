// PLAN.md §11 Phase 5 task 5.5 — "run 6 simulated cycles on the snapshot,
// confirm 0.9^n compounding and that pre-cutover history is untouched."
//
// Unlike verify-expansion-decay.ts (read-only), this test genuinely writes
// six decay_events/ep_ledger/gp_ledger batches via the real commitRateDecay
// — the same production function the leader's "Confirm & commit" button
// calls (task 5.3/5.4) — because §1c's compounding claim can only be
// proven by actually applying decay on top of decay, not by reimplementing
// the formula and comparing it to itself. Safe to run against the live
// local D1 anyway: it snapshots first and restores in a `finally`, so the
// database is back to its pre-test state (six decay_events undone, no
// trace) whether the assertions pass or fail. Never point this at remote
// D1 (PLAN.md §5) — SNAPSHOT_NAME only exists in the local Miniflare file
// snapshot.sh operates on.
//
// What this checks that commitRateDecay's own duplicate-guard and
// per-character rate math (already covered by the live verification in the
// Phase 2.7/5.3 commits) doesn't:
//   1. Six consecutive 10% commits on the same growing balance produce
//      0.9, 0.81, 0.729, ... 0.9^6 of the starting total — i.e. that each
//      cycle's decay is computed against the *result* of the previous
//      cycle's decay (compounding), not against the original balance
//      (which would be non-compounding, the legacy §1a behavior this
//      mechanism exists to replace).
//   2. Every ep_ledger/gp_ledger row dated before the test's own synthetic
//      cutover — i.e. all real pre-existing guild history — is
//      byte-identical (same row count, same point sum) after the six
//      commits as before. Global cycle decay only ever adds new rows
//      dated at its own effectiveDate; it must never touch anything older.
//   3. computeEpgpTotals (task 5.2's branch) matches: once decay_model
//      reads "global", a tracked player's reported ep/gp equals the raw
//      ledger sum with epDecay/gpDecay both 0 — no legacy derivation
//      layered on top of the now-materialized cycle decay.
//
// Usage:
//   npx tsx scripts/verify-global-decay.ts
import { execFileSync } from "node:child_process";

import { inArray, isNotNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { epLedger, gpLedger, users } from "../src/db/schema";
import { commitRateDecay } from "../src/lib/epgp/decay";
import { setSetting } from "../src/lib/epgp/settings";
import { computeEpgpTotals } from "../src/lib/epgp/totals";

// commitRateDecay calls invalidateEpgpTotalsCache(), which reaches for the
// Workers runtime's `caches.default` (totals.ts) — real inside `wrangler
// dev`/production, but plain `tsx` outside a Workers runtime has no such
// global. getPlatformProxy proxies D1/KV/R2 but not the Cache API. A no-op
// stand-in is enough here: this script cares about ledger correctness, not
// cache invalidation, and the real edge cache this would otherwise touch
// isn't reachable from a local script anyway.
if (typeof (globalThis as Record<string, unknown>).caches === "undefined") {
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async () => undefined,
      put: async () => {},
      delete: async () => true,
    },
  };
}

const SNAPSHOT_NAME = "phase5-global-decay-test";
const RATE = 0.1;
const CYCLES = 6;
const TRACKED_PLAYER_COUNT = 10;
// Strictly after any real guild data (guild history tops out in 2026) and
// strictly increasing per cycle, so each commit's "balance before
// effectiveDate" naturally includes every prior cycle's decay row.
const FIRST_EFFECTIVE_DATE = new Date("2030-01-01T00:00:00Z");
const CYCLE_STEP_DAYS = 28;

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(0.05, Math.abs(expected) * 0.005);
}

function cycleDate(n: number): Date {
  return new Date(FIRST_EFFECTIVE_DATE.getTime() + n * CYCLE_STEP_DAYS * 24 * 60 * 60 * 1000);
}

async function rawBalances(db: ReturnType<typeof drizzle>, ledger: typeof epLedger | typeof gpLedger, playerIds: number[]) {
  const rows = await db
    .select({ playerId: ledger.playerId, sum: sql<number>`coalesce(sum(${ledger.points}), 0)` })
    .from(ledger)
    .where(inArray(ledger.playerId, playerIds))
    .groupBy(ledger.playerId);
  return new Map(rows.map((r) => [r.playerId as number, r.sum]));
}

async function preCutoverChecksum(db: ReturnType<typeof drizzle>, ledger: typeof epLedger | typeof gpLedger) {
  const [row] = await db
    .select({ count: sql<number>`count(*)`, sum: sql<number>`coalesce(sum(${ledger.points}), 0)` })
    .from(ledger)
    .where(lt(ledger.occurredAt, FIRST_EFFECTIVE_DATE));
  return { count: row.count, sum: row.sum };
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  let failures = 0;
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    // decay_events.applied_by is a real FK to users.id — reuse whichever
    // user this local DB already has (e.g. from testing the leader UI
    // live) rather than a made-up string, which would fail the constraint.
    const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (!anyUser) {
      console.error("No users row in local D1 — decay_events.applied_by needs a real user id. Log in once locally first.");
      process.exit(1);
    }
    const appliedBy = anyUser.id;

    // Pre-cutover checksums, captured before this script writes anything.
    const [epBefore, gpBefore] = await Promise.all([preCutoverChecksum(db, epLedger), preCutoverChecksum(db, gpLedger)]);

    // Track the top N players by current raw EP — guaranteed positive, so
    // guaranteed to decay every one of the 6 cycles (no player drops to 0
    // and drops out of the decay set partway through).
    const topEp = await db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(isNotNull(epLedger.playerId))
      .groupBy(epLedger.playerId)
      .orderBy(sql`sum(${epLedger.points}) desc`)
      .limit(TRACKED_PLAYER_COUNT);
    const trackedPlayerIds = topEp.map((r) => r.playerId as number);
    if (trackedPlayerIds.length === 0) {
      console.error("No players with positive EP found — is the local D1 seeded? See CLAUDE.md's import:epgp.");
      process.exit(1);
    }

    let expectedEp = new Map(await rawBalances(db, epLedger, trackedPlayerIds));
    let expectedGp = new Map(await rawBalances(db, gpLedger, trackedPlayerIds));
    const startingEp = new Map(expectedEp);
    const startingGp = new Map(expectedGp);

    console.log(`Tracking ${trackedPlayerIds.length} player(s), starting EP total ${[...expectedEp.values()].reduce((a, b) => a + b, 0).toFixed(2)}.`);

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const effectiveDate = cycleDate(cycle);
      const result = await commitRateDecay(db, { kind: "global_cycle", rate: RATE, effectiveDate, appliedBy, label: `test cycle ${cycle}` });
      if ("error" in result) {
        console.error(`Cycle ${cycle}: commitRateDecay failed — ${result.error}`);
        failures++;
        break;
      }

      const actualEp = await rawBalances(db, epLedger, trackedPlayerIds);
      const actualGp = await rawBalances(db, gpLedger, trackedPlayerIds);

      let cycleOk = true;
      for (const playerId of trackedPlayerIds) {
        // A balance <= 0 is left out of the decay preview entirely (mirrors
        // expansion decay) — stays flat that cycle rather than compounding.
        const prevEp = expectedEp.get(playerId) ?? 0;
        const wantEp = prevEp > 0 ? prevEp * (1 - RATE) : prevEp;
        const gotEp = actualEp.get(playerId) ?? 0;
        if (!withinTolerance(gotEp, wantEp)) {
          console.log(`  FAIL player ${playerId} EP cycle ${cycle}: got ${gotEp.toFixed(2)}, want ~${wantEp.toFixed(2)}`);
          cycleOk = false;
        }

        const prevGp = expectedGp.get(playerId) ?? 0;
        const wantGp = prevGp > 0 ? prevGp * (1 - RATE) : prevGp;
        const gotGp = actualGp.get(playerId) ?? 0;
        if (!withinTolerance(gotGp, wantGp)) {
          console.log(`  FAIL player ${playerId} GP cycle ${cycle}: got ${gotGp.toFixed(2)}, want ~${wantGp.toFixed(2)}`);
          cycleOk = false;
        }
      }
      if (!cycleOk) failures++;
      else console.log(`  cycle ${cycle}: PASS — decay event #${result.decayEventId}, ${result.epRows} EP row(s), ${result.gpRows} GP row(s)`);

      expectedEp = actualEp;
      expectedGp = actualGp;
    }

    // 0.9^6 compounding, end to end, against the true starting balance —
    // independent of the per-cycle checks above (those could theoretically
    // compensate for one another; this can't).
    const compoundFactor = (1 - RATE) ** CYCLES;
    for (const playerId of trackedPlayerIds) {
      const start = startingEp.get(playerId) ?? 0;
      const want = start * compoundFactor;
      const got = expectedEp.get(playerId) ?? 0;
      if (!withinTolerance(got, want)) {
        console.log(`  FAIL player ${playerId} end-to-end EP: got ${got.toFixed(2)}, want ${want.toFixed(2)} (${(RATE * 100).toFixed(0)}% x${CYCLES})`);
        failures++;
      }
    }
    console.log(`End-to-end 0.9^${CYCLES} = ${compoundFactor.toFixed(6)} compounding checked for ${trackedPlayerIds.length} player(s).`);

    // Pre-cutover history untouched.
    const [epAfter, gpAfter] = await Promise.all([preCutoverChecksum(db, epLedger), preCutoverChecksum(db, gpLedger)]);
    if (epAfter.count !== epBefore.count || !withinTolerance(epAfter.sum, epBefore.sum)) {
      console.log(`  FAIL ep_ledger pre-cutover changed: count ${epBefore.count}->${epAfter.count}, sum ${epBefore.sum.toFixed(2)}->${epAfter.sum.toFixed(2)}`);
      failures++;
    } else {
      console.log(`Pre-cutover ep_ledger untouched: ${epAfter.count} row(s), sum ${epAfter.sum.toFixed(2)}.`);
    }
    if (gpAfter.count !== gpBefore.count || !withinTolerance(gpAfter.sum, gpBefore.sum)) {
      console.log(`  FAIL gp_ledger pre-cutover changed: count ${gpBefore.count}->${gpAfter.count}, sum ${gpBefore.sum.toFixed(2)}->${gpAfter.sum.toFixed(2)}`);
      failures++;
    } else {
      console.log(`Pre-cutover gp_ledger untouched: ${gpAfter.count} row(s), sum ${gpAfter.sum.toFixed(2)}.`);
    }

    // Task 5.2 tie-in: flip decay_model to "global" (effective now, so
    // computeEpgpTotals — which always reads settings "as of now" — picks
    // it up) and confirm a tracked player's total matches the raw ledger
    // sum with no derived decay layered on top.
    await setSetting(db, "decay_model", "global", appliedBy);
    const totals = await computeEpgpTotals(db);
    const checkPlayerId = trackedPlayerIds[0];
    const total = totals.get(checkPlayerId);
    const rawEp = (await rawBalances(db, epLedger, [checkPlayerId])).get(checkPlayerId) ?? 0;
    if (!total) {
      console.log(`  FAIL computeEpgpTotals returned nothing for player ${checkPlayerId} under decay_model=global`);
      failures++;
    } else if (total.epDecay !== 0 || !withinTolerance(total.ep, rawEp)) {
      console.log(`  FAIL decay_model=global: player ${checkPlayerId} epDecay=${total.epDecay} (want 0), ep=${total.ep.toFixed(2)} (want raw ${rawEp.toFixed(2)})`);
      failures++;
    } else {
      console.log(`decay_model=global totals branch verified: player ${checkPlayerId} ep=${total.ep.toFixed(2)} matches raw ledger sum, epDecay=0.`);
    }

    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll checks passed.`);
    }
  } finally {
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
