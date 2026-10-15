import { inArray, sql } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { resolveEpCaps } from "@/lib/epgp/ep-cap";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { boundedString, isoDate, LIMITS } from "@/lib/validate";

// Read-only "what will the per-cycle EP cap do to this submit?" preview for
// the officer app's confirm dialogs, so an officer sees "Aransur +30 instead
// of 50" BEFORE submitting, not just after. Runs the exact resolveEpCaps the
// real write paths use (attendance batch, manual entry) and writes nothing.
//
// Items are evaluated in order and accumulate, so a Start/Mid/End submitted
// together previews the way it will actually land. It doesn't replay the
// attendance route's duplicate skipping: a name that submit would skip as
// already recorded may still show here as capped.
//
// Body: { items: [{ activity, occurredAt, names?: string[], characterId?: number, points?: number }] }
// `points` defaults to the activity's current EP value.
const MAX_ITEMS = 20;
const MAX_NAMES = 200;

type ItemBody = { activity?: unknown; occurredAt?: unknown; names?: unknown; characterId?: unknown; points?: unknown };

export type EpCapPreviewEntry = { name: string; nominal: number; awarded: number; capped: boolean };
export type EpCapPreviewItem = { activity: string; occurredAt: string; cap: number | null; entries: EpCapPreviewEntry[] };

export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: { items?: unknown };
  try {
    body = (await request.json()) as { items?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    return Response.json({ error: `\`items\` must be an array of 1-${MAX_ITEMS} entries.` }, { status: 400 });
  }

  const db = await getDb();
  type Parsed = { activity: string; occurredAt: Date; points: number; targets: { name: string; playerId: number | null }[] };
  const parsed: Parsed[] = [];
  for (const raw of body.items as ItemBody[]) {
    const activity = boundedString(raw?.activity, { max: LIMITS.activity, min: 1, field: "activity" });
    if (!activity.ok) return Response.json({ error: activity.error }, { status: 400 });
    const date = isoDate(raw.occurredAt, "occurredAt");
    if (!date.ok) return Response.json({ error: date.error }, { status: 400 });

    let points: number | null;
    if (raw.points !== undefined) {
      if (typeof raw.points !== "number" || !Number.isFinite(raw.points)) return Response.json({ error: "`points` must be a number." }, { status: 400 });
      points = raw.points;
    } else {
      points = await getActivePointValue(db, "ep", activity.value);
      if (points === null) return Response.json({ error: `"${activity.value}" isn't a current EP activity.` }, { status: 422 });
    }

    const targets: Parsed["targets"] = [];
    if (raw.characterId !== undefined) {
      if (typeof raw.characterId !== "number" || !Number.isInteger(raw.characterId)) return Response.json({ error: "`characterId` must be an integer." }, { status: 400 });
      const [c] = await db.select({ name: characters.name, playerId: characters.playerId }).from(characters).where(inArray(characters.id, [raw.characterId]));
      if (c) targets.push({ name: c.name, playerId: c.playerId });
    } else {
      if (!Array.isArray(raw.names) || raw.names.some((n) => typeof n !== "string") || raw.names.length > MAX_NAMES) {
        return Response.json({ error: `\`names\` must be an array of at most ${MAX_NAMES} strings.` }, { status: 400 });
      }
      const names = [...new Set((raw.names as string[]).map((n) => n.trim()).filter(Boolean))];
      // Same case-insensitive resolution as POST /api/officer/attendance;
      // unmatched names are left out (the submit reports those itself).
      const byLower = new Map<string, number | null>();
      for (let i = 0; i < names.length; i += 90) {
        const chunk = names.slice(i, i + 90);
        const found = await db
          .select({ name: characters.name, playerId: characters.playerId })
          .from(characters)
          .where(sql`${characters.name} COLLATE NOCASE IN (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)})`);
        for (const c of found) byLower.set(c.name.toLowerCase(), c.playerId);
      }
      for (const name of names) {
        const playerId = byLower.get(name.toLowerCase());
        if (playerId !== undefined) targets.push({ name, playerId });
      }
    }
    parsed.push({ activity: activity.value, occurredAt: date.value, points, targets });
  }

  const flat = parsed.flatMap((p) => p.targets.map((t) => ({ playerId: t.playerId, nominal: p.points, occurredAt: p.occurredAt })));
  const outcomes = await resolveEpCaps(db, flat);
  let k = 0;
  const items: EpCapPreviewItem[] = parsed.map((p) => {
    let cap: number | null = null;
    const entries = p.targets.map((t) => {
      const o = outcomes[k++];
      cap = o.cap;
      return { name: t.name, nominal: p.points, awarded: o.awarded, capped: o.capApplied };
    });
    return { activity: p.activity, occurredAt: p.occurredAt.toISOString(), cap, entries };
  });

  return Response.json({ items });
}
