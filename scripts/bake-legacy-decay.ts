// Bake the currently-derived legacy §1a pre-cycle haircut into real stored
// ledger rows, so computeEpgpTotals can drop its decay_model read-time
// branch and a total becomes a plain SUM() (see docs/decay-refactor-plan.md).
//
// Snapshots computeEpgpTotals' CURRENT legacy output — that captures each
// player's exact epDecay/gpDecay, floor guard (rawEp < base_ep) and all,
// without re-deriving the formula here. Emits one decay_events row
// (kind 'legacy_cycle') + one linked negative ep_ledger/gp_ledger row per
// player. After applying, SUM(ledger) == the value the sheet's Totals tab
// shows today.
//
//   npx tsx scripts/bake-legacy-decay.ts            # dry run — report only
//   npx tsx scripts/bake-legacy-decay.ts --commit   # write drizzle/seed/bake-legacy-decay.sql
//   npx tsx scripts/bake-legacy-decay.ts --commit --force   # ignore the "already baked" guard
//
// Apply the emitted file the same way as the sheet seed:
//   npx wrangler d1 execute seekers-of-souls --local  --file=drizzle/seed/bake-legacy-decay.sql
//   npx wrangler d1 execute seekers-of-souls --remote --file=drizzle/seed/bake-legacy-decay.sql
//
// Reversible: reverseDecayEvent(db, <the legacy_cycle event id>) deletes
// every linked row and marks the event reversed.

import { writeFileSync } from "node:fs";

import { and, eq, isNotNull, isNull, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, decayEvents, players } from "../src/db";
import { getCurrentCycle } from "../src/lib/epgp/cycles";
import { getSettingAt } from "../src/lib/epgp/settings";
import { computeEpgpTotals } from "../src/lib/epgp/totals";

const OUT_FILE = "drizzle/seed/bake-legacy-decay.sql";
const EVENT_LABEL = "Legacy §1a cutover — pre-cycle 20% haircut materialised";
const ROW_NOTE = "legacy §1a cutover";
const ACTIVITY = "Cycle Decay";

const commit = process.argv.includes("--commit");
const force = process.argv.includes("--force");

function n(x: number): string {
  // round to 4 dp (enough for 0.2 * an integer-ish balance); normalise -0.
  const r = Math.round(x * 1e4) / 1e4;
  return String(r === 0 ? 0 : r);
}

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    // --- guard 1: decay_model must currently resolve to "legacy" ---
    const model = (await getSettingAt(db, "decay_model", new Date())) ?? "legacy";
    if (model !== "legacy") {
      console.error(
        `decay_model currently resolves to "${model}", not "legacy". Set it to legacy (with ep_decay/gp_decay = 0.2) on /epgp/settings or via epgp_settings first — the snapshot below reads whatever computeEpgpTotals derives right now.`,
      );
      process.exit(1);
    }

    // --- guard 2: not already baked ---
    const existing = await db
      .select({ id: decayEvents.id })
      .from(decayEvents)
      .where(and(eq(decayEvents.kind, "legacy_cycle"), isNull(decayEvents.reversedAt)));
    if (existing.length > 0 && !force) {
      console.error(
        `An un-reversed legacy_cycle decay_events row already exists (id ${existing.map((e) => e.id).join(", ")}). Pass --force to bake anyway, or reverseDecayEvent() it first.`,
      );
      process.exit(1);
    }

    const cycle = await getCurrentCycle(db);
    if (!cycle) {
      console.error("No current cycle resolved — cannot date the baked rows. Seed the cycles table first.");
      process.exit(1);
    }
    const effUnix = Math.floor(cycle.startDate.getTime() / 1000);

    // player_id -> a character_id for the baked ledger row: the player's
    // main if set, else their lowest-id character (Phase 3's ambiguous-main
    // players — real EP/GP, main pending a leader pick; still bake so their
    // total is right once a main is chosen).
    const playerRows = await db.select({ id: players.id, mainCharacterId: players.mainCharacterId }).from(players);
    const fallbackChar = await db
      .select({ playerId: characters.playerId, charId: min(characters.id) })
      .from(characters)
      .where(isNotNull(characters.playerId))
      .groupBy(characters.playerId);
    const fallbackByPlayer = new Map(fallbackChar.map((r) => [r.playerId as number, r.charId as number]));
    const charForPlayer = (playerId: number): number | null =>
      playerRows.find((p) => p.id === playerId)?.mainCharacterId ?? fallbackByPlayer.get(playerId) ?? null;

    // --- the snapshot ---
    const totals = await computeEpgpTotals(db, {});

    type Bake = { playerId: number; charId: number; epDecay: number; gpDecay: number };
    const bakes: Bake[] = [];
    const skippedNoChar: number[] = [];
    let totalEp = 0;
    let totalGp = 0;

    for (const [playerId, t] of totals) {
      if (t.epDecay <= 0 && t.gpDecay <= 0) continue;
      const charId = charForPlayer(playerId);
      if (charId == null) {
        skippedNoChar.push(playerId);
        continue;
      }
      bakes.push({ playerId, charId, epDecay: t.epDecay, gpDecay: t.gpDecay });
      totalEp += t.epDecay;
      totalGp += t.gpDecay;
    }
    bakes.sort((a, b) => a.charId - b.charId);

    console.log(`Current cycle: #${cycle.cycleNumber}, starts ${cycle.startDate.toISOString().slice(0, 10)} (effective_date for the baked rows).`);
    console.log(`Players with a positive derived decay: ${bakes.length}`);
    console.log(`  EP baked (total): -${n(totalEp)}   across ${bakes.filter((b) => b.epDecay > 0).length} rows`);
    console.log(`  GP baked (total): -${n(totalGp)}   across ${bakes.filter((b) => b.gpDecay > 0).length} rows`);
    if (skippedNoChar.length) {
      console.log(`Skipped (player has NO character at all): ${skippedNoChar.length} — ids ${skippedNoChar.join(", ")}`);
    }

    // sample for eyeballing against the sheet's decay columns
    const sampleIds = bakes.slice(0, 8);
    if (sampleIds.length) {
      const names = await db.select({ id: schema.characters.id, name: schema.characters.name }).from(schema.characters);
      const nameById = new Map(names.map((c) => [c.id, c.name]));
      console.log("\nSample (character: -EP decay / -GP decay):");
      for (const b of sampleIds) console.log(`  ${nameById.get(b.charId) ?? b.charId}: -${n(b.epDecay)} / -${n(b.gpDecay)}`);
    }

    if (!commit) {
      console.log(`\nDry run. Re-run with --commit to write ${OUT_FILE}.`);
      return;
    }

    // --- emit SQL ---
    const eventRef = `(SELECT id FROM decay_events WHERE kind = 'legacy_cycle' AND effective_date = ${effUnix} AND reversed_at IS NULL)`;
    const lines: string[] = [
      `-- Legacy §1a haircut baked into stored rows. Generated ${new Date().toISOString()}.`,
      `-- ${bakes.length} players, EP -${n(totalEp)}, GP -${n(totalGp)}. See docs/decay-refactor-plan.md.`,
      `-- Reverse with reverseDecayEvent(db, <this event's id>).`,
      ``,
      `INSERT INTO decay_events (kind, ep_rate, gp_rate, effective_date, label, applied_by, applied_at)`,
      `  VALUES ('legacy_cycle', 0.2, 0.2, ${effUnix}, '${EVENT_LABEL.replace(/'/g, "''")}', NULL, unixepoch());`,
      ``,
    ];
    for (const b of bakes) {
      if (b.epDecay > 0) {
        lines.push(
          `INSERT INTO ep_ledger (character_id, player_id, cycle_id, occurred_at, activity, points, points_nominal, points_awarded, note, source, decay_event_id)` +
            ` VALUES (${b.charId}, ${b.playerId}, ${cycle.id}, ${effUnix}, '${ACTIVITY}', ${n(-b.epDecay)}, ${n(-b.epDecay)}, ${n(-b.epDecay)}, '${ROW_NOTE}', 'manual', ${eventRef});`,
        );
      }
      if (b.gpDecay > 0) {
        lines.push(
          `INSERT INTO gp_ledger (character_id, player_id, cycle_id, occurred_at, tier, points, points_nominal, points_awarded, note, source, decay_event_id)` +
            ` VALUES (${b.charId}, ${b.playerId}, ${cycle.id}, ${effUnix}, '${ACTIVITY}', ${n(-b.gpDecay)}, ${n(-b.gpDecay)}, ${n(-b.gpDecay)}, '${ROW_NOTE}', 'manual', ${eventRef});`,
        );
      }
    }
    lines.push("");
    writeFileSync(OUT_FILE, lines.join("\n"));
    console.log(`\nWrote ${OUT_FILE} — ${lines.filter((l) => l.startsWith("INSERT")).length} INSERTs.`);
    console.log(`Apply:  npx wrangler d1 execute seekers-of-souls --local --file=${OUT_FILE}`);
  } finally {
    await proxy.dispose();
  }
}

main();
