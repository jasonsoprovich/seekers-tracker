// Rebuilds the `player_epgp_totals` materialized table from the ledgers via
// the real `refreshStandings({ all: true })` — the same function every write
// path calls incrementally. Use it for:
//   - the one-time backfill right after migration 0026 is applied
//   - a cycle rollover under decay_model=legacy (the pre/current-cycle split
//     moves for everyone at once; under decay_model=global this is a no-op)
//   - any time you suspect the table has drifted from the ledgers
//
// It finishes by asserting every materialized row matches a fresh
// `computeEpgpTotals(db)` to the cent, and exits non-zero on any mismatch so
// it's usable as a check. Local D1 only (PLAN.md §5) — never point tsx at
// remote D1.
//
// Usage:
//   npx tsx scripts/recompute-standings.ts
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { getStandings, refreshStandings } from "../src/lib/epgp/standings";
import { computeEpgpTotals } from "../src/lib/epgp/totals";

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01;
}

async function main() {
  const proxy = await getPlatformProxy();
  const db = drizzle((proxy.env as { DATABASE: D1Database }).DATABASE, { schema });

  const started = Date.now();
  await refreshStandings(db, { all: true });
  const materialized = await getStandings(db);
  const fresh = await computeEpgpTotals(db);

  let failures = 0;
  for (const [playerId, f] of fresh) {
    const m = materialized.get(playerId);
    if (!m) {
      console.log(`FAIL  player ${playerId} — computeEpgpTotals has it, player_epgp_totals does not`);
      failures++;
      continue;
    }
    for (const k of ["ep", "gp", "epDecay", "gpDecay", "priorityRating"] as const) {
      if (!near(m[k], f[k])) {
        console.log(`FAIL  player ${playerId} — ${k}: table ${m[k].toFixed(3)} vs compute ${f[k].toFixed(3)}`);
        failures++;
      }
    }
  }
  for (const playerId of materialized.keys()) {
    if (!fresh.has(playerId)) {
      console.log(`FAIL  player ${playerId} — in player_epgp_totals but not computeEpgpTotals (stale row not pruned)`);
      failures++;
    }
  }

  console.log(
    `\n${failures === 0 ? "OK" : "FAIL"}  ${materialized.size} players materialized in ${Date.now() - started}ms — ${failures} mismatch(es)`,
  );
  await proxy.dispose();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
