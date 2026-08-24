// PLAN.md §5 / Phase 0 task 0.8 — "the regression suite for every later
// phase." Runs the real computeEpgpTotals() production code path (via a
// local D1 binding obtained through wrangler's getPlatformProxy, backed by
// whatever .sqlite currently sits under .wrangler/state — same file
// `wrangler dev --local` uses) and asserts EP/GP/decay/priority for every
// golden-fixture character (scripts/golden-fixtures.ts) against the sheet's
// own cached numbers, within TOLERANCE.
//
// This deliberately does NOT reimplement the decay formula — a hand-rolled
// comparison formula could drift from totals.ts and both sides would agree
// while being wrong. It calls the actual function every page/route calls.
//
// Usage:
//   npx tsx scripts/verify-harness.ts
//
// Exits non-zero if any fixture fails or is missing, so it's usable as a CI
// gate later. Never point this at remote D1 (PLAN.md §5) — it's read-only,
// but "local" is what makes running it freely, on every phase, free.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters } from "../src/db/schema";
import { computeEpgpTotals } from "../src/lib/epgp/totals";
import { DEFERRED_FIXTURES, GOLDEN_FIXTURES, TOLERANCE } from "./golden-fixtures";

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const totals = await computeEpgpTotals(db);
    const allCharacters = await db.select().from(characters);
    const charByName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));

    let failures = 0;
    for (const fixture of GOLDEN_FIXTURES) {
      const char = charByName.get(fixture.name.toLowerCase());
      if (!char) {
        console.log(`FAIL  ${fixture.name.padEnd(12)} — no characters row found (has the seed been imported? see CLAUDE.md)`);
        failures++;
        continue;
      }
      // computeEpgpTotals groups by player_id, not character_id (PLAN.md
      // §11 Phase 3 task 3.11).
      if (char.playerId === null) {
        console.log(`FAIL  ${fixture.name.padEnd(12)} — character id ${char.id} has no player_id`);
        failures++;
        continue;
      }
      const t = totals.get(char.playerId);
      if (!t) {
        console.log(`FAIL  ${fixture.name.padEnd(12)} — computeEpgpTotals returned nothing for player id ${char.playerId}`);
        failures++;
        continue;
      }

      const checks: [string, number, number][] = [
        ["ep", t.ep, fixture.expected.ep],
        ["gp", t.gp, fixture.expected.gp],
        ["epDecay", t.epDecay, fixture.expected.epDecay],
        ["gpDecay", t.gpDecay, fixture.expected.gpDecay],
        ["priority", t.priorityRating, fixture.expected.priority],
      ];
      const mismatches = checks.filter(([, got, want]) => !close(got, want));

      if (mismatches.length === 0) {
        console.log(`PASS  ${fixture.name.padEnd(12)} (${fixture.category})`);
      } else {
        failures++;
        console.log(`FAIL  ${fixture.name.padEnd(12)} (${fixture.category})`);
        for (const [field, got, want] of mismatches) {
          console.log(`        ${field}: got ${got.toFixed(4)}, want ${want} (diff ${(got - want).toFixed(4)})`);
        }
      }
    }

    console.log(`\n${GOLDEN_FIXTURES.length - failures}/${GOLDEN_FIXTURES.length} fixtures passed (tolerance ±${TOLERANCE}).`);

    if (DEFERRED_FIXTURES.length > 0) {
      console.log(`\n${DEFERRED_FIXTURES.length} fixture categor${DEFERRED_FIXTURES.length === 1 ? "y" : "ies"} documented but not yet asserted (need a later phase's schema/logic):`);
      for (const d of DEFERRED_FIXTURES) console.log(`  - ${d.category}: ${d.note}`);
    }

    if (failures > 0) {
      console.error(`\n${failures} fixture(s) failed.`);
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
