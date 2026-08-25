import { DurableObject } from "cloudflare:workers";

// PLAN.md §15 / Phase 12 task 12.1. One guild-wide live auction — the
// parser app collects bids for one item at a time (see BidsPanel.tsx),
// so a single DO instance (accessed via a fixed idFromName, see
// getLiveAuctionSessionStub in src/lib/live-bids/session.ts) is enough;
// no per-item sharding.
//
// Deliberately in-memory only, no `ctx.storage` reads/writes on the hot
// path: every push/broadcast during a bid round never touches billed
// storage, which is what makes constant live-viewing safe on the free
// tier at 3-5 events/week. A DO eviction between events just means the
// next "send tells" starts from empty state, which is correct anyway —
// there's nothing worth persisting between auctions.

export type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type PushBody = { itemName?: unknown; characterName?: unknown; tier?: unknown; occurredAt?: unknown; priorityRating?: unknown };

type ValidPushBody = { itemName: string; characterName: string; tier: string; occurredAt: string; priorityRating?: unknown };

type ServerMessage = { type: "state"; itemName: string | null; bids: LiveBidTell[] } | { type: "cleared" };

function isPushBody(v: unknown): v is ValidPushBody {
  const b = v as PushBody;
  return typeof b?.itemName === "string" && typeof b?.characterName === "string" && typeof b?.tier === "string" && typeof b?.occurredAt === "string";
}

export class LiveAuctionSession extends DurableObject<CloudflareEnv> {
  private itemName: string | null = null;
  private bids: LiveBidTell[] = [];

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

      this.broadcast(this.stateMessage());
      return Response.json({ ok: true }, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/clear") {
      this.itemName = null;
      this.bids = [];
      this.broadcast({ type: "cleared" });
      return Response.json({ ok: true }, { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  // Required by the hibernation API even though viewers never send
  // anything meaningful, and there's no per-socket state to clean up on
  // close — a read-only live view has nothing to say back or track.
  async webSocketMessage() {}
  async webSocketClose() {}

  private stateMessage(): ServerMessage {
    return { type: "state", itemName: this.itemName, bids: this.bids };
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
