// PLAN.md §11 Phase 4 task 4.5 — "Test against the 31 historical sub-12
// events — all should be rejected by the new rule."
//
// This groups every historical ep_ledger row whose activity is one of the
// attendance-gated activities (Raid - Start/Mid/End, Event Attend) by
// (occurred_at, activity) and counts distinct player_id — that's exactly
// what one "/who guild" capture produced, since insertLedgerEntry writes
// one row per attendee. Each group's count is fed through the real
// checkMinAttendance() (src/lib/epgp/attendance.ts) — the same function
// POST /api/officer/attendance calls — rather than reimplementing the
// >= comparison, so a change to that function's logic shows up here too.
//
// **The exact "31" from §4h is NOT asserted here — it's a snapshot from
// whenever that section was verified, not a fixed historical constant.**
// Sanity-checked against the local snapshot on 2026-08-23: median/max/min
// distinct-attendee counts across groups matched §4h's "median 27 [26
// here — one sheet re-export off], max 52, min 1" almost exactly,
// confirming the grouping/counting method is the same one §4h used — but
// the sub-12 count itself had grown to 66. The guild has kept raiding
// (sparse "Event Attend" sessions especially) in the time since §4h's
// figure was written, and every sheet re-import (CLAUDE.md's own
// "commonly drifts... by a row or two" note) adds more thin-attendance
// events to the ledger. A live, ever-growing count isn't a fixed value a
// regression test should assert equality against.
//
// What this script actually gates on instead: an independent cross-check
// against the literal historical default (12) — min_attendance has never
// been changed away from that value in this dataset — so if
// checkMinAttendance's real (effective-dated) resolution or its >=
// comparison ever disagrees with a plain `count < 12`, that's a real bug,
// not dataset drift.
//
// This is read-only: it doesn't call the API route or write anything, so
// it's safe against a real seeded snapshot, not just an empty dev DB.
//
// Usage:
//   npx tsx scripts/verify-attendance-minimum.ts
import { and, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { epLedger } from "../src/db/schema";
import { ATTENDANCE_GATED_ACTIVITIES, checkMinAttendance } from "../src/lib/epgp/attendance";
import { DEFAULT_SETTINGS } from "../src/lib/epgp/settings";

// Never changed in this dataset — an independent check that doesn't go
// through getSettingAt, so it can catch a bug in that resolution path
// instead of just agreeing with it by construction.
const HISTORICAL_DEFAULT_MIN_ATTENDANCE = Number(DEFAULT_SETTINGS.min_attendance);

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const rows = await db
      .select({ activity: epLedger.activity, occurredAt: epLedger.occurredAt, playerId: epLedger.playerId })
      .from(epLedger)
      .where(and(inArray(epLedger.activity, [...ATTENDANCE_GATED_ACTIVITIES]), isNotNull(epLedger.playerId)));

    const groups = new Map<string, { activity: string; occurredAt: Date; players: Set<number> }>();
    for (const row of rows) {
      const key = `${row.activity}__${row.occurredAt.toISOString()}`;
      let group = groups.get(key);
      if (!group) {
        group = { activity: row.activity, occurredAt: row.occurredAt, players: new Set() };
        groups.set(key, group);
      }
      group.players.add(row.playerId!);
    }

    let rejected = 0;
    let mismatches = 0;
    const details: string[] = [];
    for (const { activity, occurredAt, players } of groups.values()) {
      const result = await checkMinAttendance(db, activity, occurredAt, players.size);
      const expectRejected = players.size < HISTORICAL_DEFAULT_MIN_ATTENDANCE;
      if (result.ok === expectRejected) {
        // result.ok true means "accepted" — this branch is true exactly
        // when accepted-vs-rejected disagrees with the independent check.
        mismatches++;
        console.log(
          `MISMATCH ${occurredAt.toISOString()} ${activity.padEnd(14)} — ${players.size} attendees, checkMinAttendance says ${result.ok ? "OK" : "reject"}, expected ${expectRejected ? "reject" : "OK"}`,
        );
      }
      if (!result.ok) {
        rejected++;
        details.push(`  ${occurredAt.toISOString()} ${activity.padEnd(14)} — ${result.count} of ${result.required} required`);
      }
    }

    console.log(`${groups.size} historical attendance-gated captures found.`);
    console.log(`${rejected} would be rejected by checkMinAttendance() under today's effective thresholds (§4h's own count was 31 — see file header).`);
    if (details.length > 0) {
      console.log("\nRejected captures:");
      console.log(details.sort().join("\n"));
    }

    if (mismatches > 0) {
      console.error(`\n${mismatches} group(s) disagree with a plain "count < ${HISTORICAL_DEFAULT_MIN_ATTENDANCE}" check — checkMinAttendance has a real bug.`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${groups.size} groups agree with the independent count < ${HISTORICAL_DEFAULT_MIN_ATTENDANCE} cross-check.`);
    }
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
