import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getLiveAuctionSessionStub } from "@/lib/live-bids/session";

// New 2026-08-25 (live-bids idle detection). The parser app's 5s poll
// ticker calls this whenever a tick finds nothing new to push — previously
// it just skipped the tick entirely, which is why a quiet round (no
// bidding for a while, officer still there) was indistinguishable from the
// officer having closed the app: the DO had no signal at all during a
// silent stretch. This route writes nothing to D1, same as /push — it only
// bumps the DO's lastSeenAt/pusherUserId.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const stub = await getLiveAuctionSessionStub();
  const resp = await stub.fetch("https://live-auction-session/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pusherUserId: auth.userId }),
  });

  if (!resp.ok) {
    return Response.json({ error: "Live session rejected the heartbeat." }, { status: 502 });
  }
  return Response.json({ ok: true }, { status: 200 });
}
