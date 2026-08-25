import { eq } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { getCachedEpgpTotals } from "@/lib/epgp/totals";
import { getLiveAuctionSessionStub } from "@/lib/live-bids/session";

type PushRequestBody = { itemName?: unknown; characterName?: unknown; tier?: unknown; occurredAt?: unknown };

// PLAN.md §15 / Phase 12 task 12.2. Pushes one detected bid tell into the
// live-auction DO, *before* the officer finalizes via POST
// /api/officer/bids — that route stays the unchanged source of truth
// (writes loot_events/bids/GP charge). This route never writes to D1 at
// all, only resolves the bidder's current priority (same lookup
// /api/officer/bids already does per-entry) so the live view can show it
// alongside the bid without a separate roster fetch on the browser side.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: PushRequestBody;
  try {
    body = (await request.json()) as PushRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.itemName !== "string" || !body.itemName.trim()) {
    return Response.json({ error: "`itemName` is required." }, { status: 400 });
  }
  if (typeof body.characterName !== "string" || !body.characterName.trim()) {
    return Response.json({ error: "`characterName` is required." }, { status: 400 });
  }
  if (typeof body.tier !== "string" || !body.tier.trim()) {
    return Response.json({ error: "`tier` is required." }, { status: 400 });
  }
  if (typeof body.occurredAt !== "string" || Number.isNaN(new Date(body.occurredAt).getTime())) {
    return Response.json({ error: "`occurredAt` must be a valid date." }, { status: 400 });
  }

  const characterName = body.characterName.trim();
  const db = await getDb();

  // Best-effort priority lookup — an unmatched/never-imported name (the
  // same "no match" case the officer's own review table handles) still
  // gets pushed live with priorityRating: null rather than being dropped,
  // since the live view exists to preserve the guild's old "watch the
  // sheet fill in live" experience even for a name that needs resolving.
  const [character] = await db.select({ playerId: characters.playerId }).from(characters).where(eq(characters.name, characterName));
  let priorityRating: number | null = null;
  if (character?.playerId != null) {
    const totals = await getCachedEpgpTotals(db);
    priorityRating = totals.get(character.playerId)?.priorityRating ?? null;
  }

  const stub = await getLiveAuctionSessionStub();
  const resp = await stub.fetch("https://live-auction-session/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemName: body.itemName.trim(),
      characterName,
      tier: body.tier.trim(),
      occurredAt: body.occurredAt,
      priorityRating,
    }),
  });

  if (!resp.ok) {
    return Response.json({ error: "Live session rejected the push." }, { status: 502 });
  }
  return Response.json({ ok: true }, { status: 200 });
}
