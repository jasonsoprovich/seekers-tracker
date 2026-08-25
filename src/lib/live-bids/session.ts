import { getCloudflareContext } from "@opennextjs/cloudflare";

// One live-auction DO instance, guild-wide — the parser app collects bids
// for one item at a time (see seekers-epgp-parser's BidsPanel.tsx), so
// there's never more than one live round in flight. See
// live-auction-session.ts's own comment for why a fixed name is enough.
const SESSION_NAME = "global";

export async function getLiveAuctionSessionStub() {
  const { env } = await getCloudflareContext({ async: true });
  const id = env.LIVE_AUCTION_SESSION.idFromName(SESSION_NAME);
  return env.LIVE_AUCTION_SESSION.get(id);
}
