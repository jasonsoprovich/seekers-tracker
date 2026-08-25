import { DurableObject } from "cloudflare:workers";

// PLAN.md §15 / Phase 12 task 12.1. One guild-wide live auction — the
// parser app collects bids for one item at a time (see BidsPanel.tsx),
// so a single DO instance (accessed via a fixed idFromName, see
// getLiveAuctionSessionStub in src/lib/live-bids/session.ts) is enough;
// no per-item sharding.
//
// Deliberately in-memory only, no `ctx.storage` reads/writes of
// application data (itemName/bids/lastSeenAt) on the hot path: every
// push/broadcast during a bid round never touches billed storage, which is
// what makes constant live-viewing safe on the free tier at 3-5
// events/week. A DO eviction between events just means the next
// "send tells" starts from empty state, which is correct anyway — there's
// nothing worth persisting between auctions. `ctx.storage.setAlarm()` is
// the one exception (below) — scheduling/rescheduling a timer is a
// different, much cheaper primitive than a data read/write and doesn't
// carry the same per-event storage cost this design otherwise avoids.
//
// Idle detection (2026-08-25): originally this DO had no notion of time at
// all, so the client showed a green "Live" pill against a round that ended
// hours ago — nothing distinguished "an officer is mid-round but nobody's
// bid in 90 seconds" from "the officer closed the app and this state will
// never change again." The parser app's push loop is itself silent during
// quiet stretches (only reacts to new bids), so absence of pushes can't
// mean "gone" — a real heartbeat is required. lastSeenAt is bumped by
// both /push and the new /heartbeat; TTL_MS is three missed 5s parser-app
// ticks plus slack.
const TTL_MS = 90_000;

export type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type PushBody = { itemName?: unknown; characterName?: unknown; tier?: unknown; occurredAt?: unknown; priorityRating?: unknown; pusherUserId?: unknown };
type ValidPushBody = { itemName: string; characterName: string; tier: string; occurredAt: string; priorityRating?: unknown; pusherUserId?: unknown };

type HeartbeatBody = { pusherUserId?: unknown };

type LiveStatus = "live" | "idle";

type ServerMessage =
  | { type: "state"; itemName: string | null; bids: LiveBidTell[]; status: LiveStatus; lastSeenAt: number | null }
  | { type: "cleared" };

function isPushBody(v: unknown): v is ValidPushBody {
  const b = v as PushBody;
  return typeof b?.itemName === "string" && typeof b?.characterName === "string" && typeof b?.tier === "string" && typeof b?.occurredAt === "string";
}

export class LiveAuctionSession extends DurableObject<CloudflareEnv> {
  private itemName: string | null = null;
  private bids: LiveBidTell[] = [];
  private lastSeenAt: number | null = null;
  private pusherUserId: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernatable — a quiet auction (no bids for a while) doesn't keep
      // this DO billed as active just because viewers are still connected.
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return Response.json(this.stateMessage());
    }

    if (request.method === "POST" && url.pathname === "/push") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      if (!isPushBody(body)) {
        return Response.json({ error: "itemName, characterName, tier, occurredAt are required." }, { status: 400 });
      }

      // A different item name than the one currently live starts a fresh
      // round — matches the parser app's one-item-at-a-time capture flow
      // (BidsPanel: naming a new item and clicking Capture Bids implies
      // the previous round is over even if the officer forgot to Submit).
      if (this.itemName !== body.itemName) {
        this.itemName = body.itemName;
        this.bids = [];
      }

      const priorityRating = typeof body.priorityRating === "number" ? body.priorityRating : null;
      const tell: LiveBidTell = { characterName: body.characterName, tier: body.tier, occurredAt: body.occurredAt, priorityRating };

      // Latest tell per character wins, same "changed my mind" rule as
      // ResolveLatestPerCharacter on the parser-app side — this view
      // should show the same picture the officer's own review table will.
      const existingIndex = this.bids.findIndex((b) => b.characterName.toLowerCase() === tell.characterName.toLowerCase());
      if (existingIndex >= 0) {
        this.bids[existingIndex] = tell;
      } else {
        this.bids.push(tell);
      }

      this.markSeen(typeof body.pusherUserId === "string" ? body.pusherUserId : null);
      this.broadcast(this.stateMessage());
      return Response.json({ ok: true }, { status: 200 });
    }

    // Bumps lastSeenAt without touching itemName/bids — the parser app's
    // 5s poll ticker sends this whenever it has nothing new to push, so a
    // quiet round (no bidding for a while, officer still there) still
    // reads as "live" rather than degrading to idle just because nothing
    // changed. Still broadcasts (cheap — an in-memory send to already-open
    // sockets, no storage write) so an open viewer's "last update" ticks.
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // no body is fine — pusherUserId is optional
      }
      const { pusherUserId } = body as HeartbeatBody;
      this.markSeen(typeof pusherUserId === "string" ? pusherUserId : null);
      this.broadcast(this.stateMessage());
      return Response.json({ ok: true }, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/clear") {
      this.itemName = null;
      this.bids = [];
      this.lastSeenAt = null;
      this.pusherUserId = null;
      await this.ctx.storage.deleteAlarm();
      this.broadcast({ type: "cleared" });
      return Response.json({ ok: true }, { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  // Fires once TTL_MS has passed with no push/heartbeat — pushes the idle
  // transition to open viewers instead of only resolving it lazily on
  // their next state read, so a tab left open actually shows "Idle"
  // without the viewer having to do anything. setAlarm() replaces any
  // previously-scheduled alarm, so a push/heartbeat that arrives before
  // this fires reschedules it forward and this stale firing never happens.
  async alarm() {
    if (this.status() === "idle") this.broadcast(this.stateMessage());
  }

  // Required by the hibernation API even though viewers never send
  // anything meaningful, and there's no per-socket state to clean up on
  // close/error — a read-only live view has nothing to say back or track.
  async webSocketMessage() {}
  async webSocketClose() {}
  async webSocketError() {}

  private markSeen(pusherUserId: string | null) {
    this.lastSeenAt = Date.now();
    if (pusherUserId) this.pusherUserId = pusherUserId;
    // Scheduling a timer, not a data write — see the class-level comment
    // on why this doesn't reintroduce the per-push storage cost the rest
    // of this DO deliberately avoids.
    void this.ctx.storage.setAlarm(this.lastSeenAt + TTL_MS);
  }

  private status(): LiveStatus {
    return this.lastSeenAt !== null && Date.now() - this.lastSeenAt < TTL_MS ? "live" : "idle";
  }

  private stateMessage(): ServerMessage {
    return { type: "state", itemName: this.itemName, bids: this.bids, status: this.status(), lastSeenAt: this.lastSeenAt };
  }

  private broadcast(message: ServerMessage) {
    const encoded = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(encoded);
      } catch {
        // a dead socket the hibernation API hasn't reaped yet — ignore,
        // it'll be cleaned up on its own close/error event.
      }
    }
  }
}
