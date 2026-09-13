import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { finalizeBidRound, type FinalizeBidRoundInput } from "@/lib/epgp/bid-finalization";

// This route does NOT touch the LiveAuctionSession DO. The parser app
// clears its own live round the moment the officer clicks "End Round &
// Review" (and on app quit) via POST /api/officer/live-bids/clear, which
// is served from custom-worker.ts — so by the time a finalize lands here,
// the live view has already dropped this round. The DO clear used to run
// here too, as belt-and-suspenders, but a DO RPC from a Next Route
// Handler crosses the OpenNext Node loopback (workerd → Node → workerd)
// and that hop crashes `wrangler dev` under load — the exact failure
// documented in CLAUDE.md's "Hard-won gotchas". It was the last such hop
// left; removing it is what keeps local dev up during a live round.
// (If a stale round ever does linger, the DO's own 5-min idle expiry
// sweeps it — no signal from a finalized round's poller means it ages
// out regardless.)
//
// The actual finalize logic — validation, the atomic write, idempotent
// retry handling — lives in src/lib/epgp/bid-finalization.ts (PLAN.md §11
// Phase 3), so it can run against local D1 directly from
// scripts/verify-bid-finalization.ts without a live Worker request
// context, same as insertLedgerEntry/decay.ts's core logic.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: FinalizeBidRoundInput;
  try {
    body = (await request.json()) as FinalizeBidRoundInput;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const db = await getDb();
  const result = await finalizeBidRound(db, body, auth.userId);

  if (!result.ok) {
    return Response.json(
      {
        error: result.error,
        ...(result.duplicate ? { duplicate: result.duplicate } : {}),
        ...(result.unmatched ? { unmatched: result.unmatched, invalidTiers: result.invalidTiers } : {}),
      },
      { status: result.status },
    );
  }

  return Response.json(
    {
      lootEventId: result.lootEventId,
      inserted: result.inserted,
      unmatched: result.unmatched,
      invalidTiers: result.invalidTiers,
      ...(result.replay ? { replay: true } : {}),
    },
    { status: result.status },
  );
}
