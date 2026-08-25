import { fetchIsMemberAllowed } from "@/lib/discord-verify";
import { getDb } from "@/lib/db";
import { getLiveAuctionSessionStub } from "@/lib/live-bids/session";
import { getSession } from "@/lib/session";

// New 2026-08-25 — backs the Live Bids page's Refresh button. Before this,
// the DO only spoke /ws (a WebSocket upgrade), /push, and /clear; there was
// no plain read path at all, so a stuck/stale connection had no way to
// re-sync short of a full page reload. Same auth as the WebSocket upgrade
// itself (custom-worker.ts's handleLiveBidsWebSocket) — a real session plus
// guild membership, not the officer API key /push and /heartbeat use, since
// every member can view live bids, not just officers.
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });

  const db = await getDb();
  if (!(await fetchIsMemberAllowed(db, session.user.id))) {
    return Response.json({ error: "Not allowed." }, { status: 403 });
  }

  const stub = await getLiveAuctionSessionStub();
  const resp = await stub.fetch("https://live-auction-session/state");
  if (!resp.ok) {
    return Response.json({ error: "Live session unavailable." }, { status: 502 });
  }
  return new Response(await resp.text(), { headers: { "Content-Type": "application/json" } });
}
