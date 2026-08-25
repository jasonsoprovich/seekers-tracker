import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getLiveAuctionSessionStub } from "@/lib/live-bids/session";

// New 2026-08-25, alongside /heartbeat. Previously the DO's /clear was
// only ever called internally by POST /api/officer/bids on finalize — there
// was no way for the parser app itself to say "this round is over" (app
// closed, capture cancelled). The parser app now calls this when it quits
// mid-round, so the live view drops to empty immediately instead of
// waiting out the idle TTL. Same officer-key gate as /push and /heartbeat;
// unlike the finalize route's clear, this one intentionally does NOT wrap
// in try/finally for anything else — there's nothing else in this request
// to protect.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const stub = await getLiveAuctionSessionStub();
  const resp = await stub.fetch("https://live-auction-session/clear", { method: "POST" });
  if (!resp.ok) {
    return Response.json({ error: "Live session rejected the clear." }, { status: 502 });
  }
  return Response.json({ ok: true }, { status: 200 });
}
