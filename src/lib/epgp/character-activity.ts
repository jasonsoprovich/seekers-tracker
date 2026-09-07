import { and, eq, isNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, gpLedger } from "@/db";

type Db = ReturnType<typeof drizzle>;

// Recompute one character's denormalized `characters.last_activity_at` from
// its non-decay ledger rows. Called after a ledger edit/delete
// (src/app/(app)/epgp/ledger/actions.ts), where the changed row might have
// been that character's most recent — a plain "bump if newer" (what
// insertLedgerEntry does on an award) can't move the value *backwards*.
export async function recomputeCharacterLastActivity(db: Db, characterId: number): Promise<void> {
  const [ep, gp] = await Promise.all([
    db
      .select({ t: sql<number | null>`max(${epLedger.occurredAt})` })
      .from(epLedger)
      .where(and(eq(epLedger.characterId, characterId), isNull(epLedger.decayEventId))),
    db
      .select({ t: sql<number | null>`max(${gpLedger.occurredAt})` })
      .from(gpLedger)
      .where(and(eq(gpLedger.characterId, characterId), isNull(gpLedger.decayEventId))),
  ]);
  // occurred_at is stored in unix seconds; drizzle's timestamp conversion
  // only applies to plain column selects, not sql`max(...)`.
  const maxSec = Math.max(ep[0]?.t ?? 0, gp[0]?.t ?? 0);
  await db
    .update(characters)
    .set({ lastActivityAt: maxSec > 0 ? new Date(maxSec * 1000) : null })
    .where(eq(characters.id, characterId));
}

// Full recompute of `characters.last_activity_at` for every character —
// the same statement migration 0031 runs as its backfill. The nightly
// scheduled job (custom-worker.ts) re-runs this so the column self-heals
// any drift, and rebuildAllStandings calls it too. One pass over each
// ledger's occurred_at index; not a per-request path.
export async function recomputeAllCharacterLastActivity(db: Db): Promise<void> {
  await db.run(sql`
    UPDATE characters SET last_activity_at = (
      SELECT MAX(t) FROM (
        SELECT MAX(occurred_at) AS t FROM ep_ledger WHERE character_id = characters.id AND decay_event_id IS NULL
        UNION ALL
        SELECT MAX(occurred_at) AS t FROM gp_ledger WHERE character_id = characters.id AND decay_event_id IS NULL
      )
    )
  `);
}

// NOTE: the old `getCharacterLastActivitySince(db, since)` — a full-year
// GROUP BY max() over both ledgers, run per request by roster / dashboard /
// progression — was replaced by the materialized `characters.last_activity_at`
// column (migration 0031). Those pages now read that column directly; this
// module only recomputes it. The per-CHARACTER (not per-player) distinction
// still matters: an alt must not inherit its main's most recent ledger row,
// which is why the value lives on `characters` and not `player_epgp_totals`
// (leader, 2026-09-05 — "98 active in 24h" was inflated by exactly that).
