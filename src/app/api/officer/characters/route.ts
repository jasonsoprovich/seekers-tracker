import { asc, eq } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { getCachedEpgpTotals } from "@/lib/epgp/totals";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "@/lib/eq/enums";

// Roster snapshot for the EPGP parser app's local name-matching/validation
// (attendance and bid rows reference characters by name — see the app's
// own validate-before-submit flow) before it ever calls
// /api/officer/manual-entry, /attendance, or /bids.
//
// mainCharacterName + priorityRating are resolved the same way Roster's own
// totalsFor does: computeEpgpTotals groups by player_id (PLAN.md §11 Phase 3
// task 3.11), so every character sharing a player reads the same priority —
// the app's Bids/Attendance tables show both columns so an officer can see
// at a glance whose priority actually applies to a bid.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        charType: characters.charType,
        mainCharacterId: characters.mainCharacterId,
        status: characters.status,
        playerId: characters.playerId,
      })
      .from(characters)
      .orderBy(asc(characters.name)),
    getCachedEpgpTotals(db),
  ]);

  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  const result = rows.map((r) => {
    const isAlt = r.charType === "alt" && r.mainCharacterId !== null;
    const total = r.playerId !== null ? totals.get(r.playerId) : undefined;
    return {
      id: r.id,
      name: r.name,
      charType: r.charType,
      mainCharacterId: r.mainCharacterId,
      status: r.status,
      mainCharacterName: isAlt ? (nameById.get(r.mainCharacterId as number) ?? null) : null,
      priorityRating: total?.priorityRating ?? null,
    };
  });

  return Response.json({ characters: result });
}

type CreateCharacterBody = { name?: unknown; mainCharacterId?: unknown };

// Same cause-chain walk as characters/actions.ts's isUniqueConstraintError
// — Drizzle's D1 driver wraps the underlying SQLite error in
// DrizzleQueryError.cause rather than surfacing it as a typed exception.
function isUniqueConstraintError(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

// Lets the parser app's Attendance/Bids "no match" rows resolve a name the
// site roster has never seen — either as a brand-new main, or as a new alt
// immediately linked to an existing main — without an officer having to
// stop and use the site's own /characters form mid-raid. class/race/level
// are unknowable from a log capture, so this follows the same
// UNKNOWN_CLASS_ID/UNKNOWN_RACE_ID/level-1 placeholder convention
// scripts/import-epgp.ts uses for sheet-only characters; the officer or
// the player can fill in real values later from /characters.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: CreateCharacterBody;
  try {
    body = (await request.json()) as CreateCharacterBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "Character name is required." }, { status: 400 });
  if (name.length > 64) return Response.json({ error: "Name must be 64 characters or fewer." }, { status: 400 });

  const db = await getDb();

  let mainCharacterId: number | null = null;
  let mainCharacterName: string | null = null;
  if (body.mainCharacterId !== undefined && body.mainCharacterId !== null) {
    mainCharacterId = Number(body.mainCharacterId);
    if (!Number.isInteger(mainCharacterId) || mainCharacterId <= 0) {
      return Response.json({ error: "Invalid main character selection." }, { status: 400 });
    }
    const [target] = await db
      .select({ name: characters.name, charType: characters.charType })
      .from(characters)
      .where(eq(characters.id, mainCharacterId));
    if (!target) return Response.json({ error: "Selected main character no longer exists." }, { status: 400 });
    if (target.charType !== "main") return Response.json({ error: "Selected main character must itself be a main." }, { status: 400 });
    mainCharacterName = target.name;
  }

  try {
    const [created] = await db
      .insert(characters)
      .values({
        name,
        class: UNKNOWN_CLASS_ID,
        race: UNKNOWN_RACE_ID,
        level: 1,
        charType: mainCharacterId ? "alt" : "main",
        mainCharacterId,
      })
      .returning();

    return Response.json(
      {
        id: created.id,
        name: created.name,
        charType: created.charType,
        mainCharacterId: created.mainCharacterId,
        status: created.status,
        mainCharacterName,
        priorityRating: null,
      },
      { status: 201 },
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return Response.json({ error: `A character named "${name}" already exists.` }, { status: 409 });
    }
    throw err;
  }
}
