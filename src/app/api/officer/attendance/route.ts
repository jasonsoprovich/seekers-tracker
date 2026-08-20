import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getActivePointValue } from "@/lib/epgp/point-values";

type AttendanceRequestBody = {
  activity?: unknown;
  occurredAt?: unknown;
  characterNames?: unknown;
  note?: unknown;
};

// Bulk EP award from the officer app's Attendance capture (one "/who
// guild" snapshot -> everyone in it gets the same activity/points). Points
// are resolved server-side from epgp_point_values, not trusted from the
// caller — see src/lib/epgp/point-values.ts. Names that don't match a
// characters row are reported back rather than silently dropped, so the
// officer can fix a typo'd name and resubmit just that name (e.g. via
// manual-entry) instead of wondering who's missing.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: AttendanceRequestBody;
  try {
    body = (await request.json()) as AttendanceRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.activity !== "string" || !body.activity.trim()) {
    return Response.json({ error: "`activity` is required." }, { status: 400 });
  }
  if (typeof body.occurredAt !== "string" || !body.occurredAt) {
    return Response.json({ error: "`occurredAt` is required." }, { status: 400 });
  }
  if (!Array.isArray(body.characterNames) || body.characterNames.some((n) => typeof n !== "string")) {
    return Response.json({ error: "`characterNames` must be an array of strings." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note : "";

  const db = await getDb();
  const points = await getActivePointValue(db, "ep", body.activity);
  if (points === null) {
    return Response.json({ error: `"${body.activity}" isn't a current EP activity.` }, { status: 422 });
  }

  const names = [...new Set(body.characterNames.map((n) => n.trim()).filter(Boolean))];
  const unmatched: string[] = [];
  let inserted = 0;

  for (const name of names) {
    const characterId = await findCharacterIdByName(db, name);
    if (characterId === null) {
      unmatched.push(name);
      continue;
    }
    const result = await insertLedgerEntry(
      db,
      { kind: "ep", characterId, activity: body.activity, points, occurredAt: body.occurredAt, note },
      auth.userId,
      "parse",
    );
    if (result.ok) inserted++;
    else unmatched.push(name);
  }

  return Response.json({ inserted, unmatched }, { status: 201 });
}
