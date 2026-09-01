import { DurableObject } from "cloudflare:workers";

// PLAN.md §15 / Phase 12 task 12.1, extended by Phase 16. One guild-wide
// live-auction DO tracking MULTIPLE concurrent rounds — during a raid, 1-10
// officers each run their own parser app on their own API key and collect
// bids for *different* items in parallel to speed up looting (confirmed
// with the leader 2026-08-30). Keyed by item name (lowercased): two
// officers never collect the same item at once, and "a new item name is a
// new round" is already how the parser's capture flow works.
// `idFromName("global")` still gives one instance for the whole guild —
// every caller resolves it that way (see `liveAuctionStub` in
// custom-worker.ts).
//
// Deliberately in-memory only, no `ctx.storage` reads/writes of round data
// on the hot path: every push/broadcast during a raid never touches billed
// storage, which is what keeps constant live-viewing free-tier-safe at
// 5-50 viewers. A DO eviction between events just means the next
// "send tells" starts from empty state, which is correct anyway. The one
// storage touch is `ctx.storage.setAlarm()` (scheduling a timer, not a
// data write) to sweep expired rounds — debounced so a 5-10x/minute poll
// across all officers doesn't churn it.
//
// A round is "collecting" (bids still coming in) or "resolved" (Phase 16 —
// the officer finalized it; it lingers with its winner(s) so members can
// review who bid what). While collecting: "live" for LIVE_TTL_MS after the
// last push/heartbeat, then "idle", then dropped after ROUND_EXPIRY_MS with
// no signal. Once resolved: shown until RESOLVED_EXPIRY_MS after resolvedAt,
// OR until the same officer opens a round for the NEXT item (their
// attention has moved on — see the /push handler), OR until a member
// dismisses it (/dismiss). A resolved round never touches another officer's
// rounds when it sweeps.
const LIVE_TTL_MS = 90_000;
const ROUND_EXPIRY_MS = 300_000;
const RESOLVED_EXPIRY_MS = 1_200_000; // 20 min of post-finalize review time

// The parser poll fires a push or heartbeat every ~5s per officer for a
// whole round. Re-arming the sweep alarm on every one is pointless — it
// only has to fire "roughly when the soonest round would expire", and tens
// of seconds of slop is fine. markSeen only re-arms when the pending alarm
// is more than this stale; alarm() re-arms itself while any round is still
// alive. (This churn also destabilises miniflare's local DO alarm impl
// under `wrangler dev` — harmless on real Cloudflare, but see CLAUDE.md.)
const ALARM_DEBOUNCE_MS = 20_000;

export type LiveBidTell = {
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating: number | null;
};

type LiveStatus = "live" | "idle" | "resolved";

type Round = {
  itemName: string;
  officerId: string;
  officerName: string;
  bids: LiveBidTell[];
  lastSeenAt: number;
  startedAt: number;
  // "collecting" until the officer finalizes; "resolved" after, with
  // winners set and resolvedAt stamped.
  state: "collecting" | "resolved";
  winners: LiveBidTell[];
  resolvedAt: number;
};

type RoundView = {
  itemName: string;
  officerName: string;
  bids: LiveBidTell[];
  winners: LiveBidTell[];
  status: LiveStatus;
  lastSeenAt: number;
};

type ServerMessage = { type: "state"; rounds: RoundView[] };

type PushBody = {
  itemName?: unknown;
  characterName?: unknown;
  tier?: unknown;
  occurredAt?: unknown;
  priorityRating?: unknown;
  officerId?: unknown;
  officerName?: unknown;
};
type ValidPushBody = {
  itemName: string;
  characterName: string;
  tier: string;
  occurredAt: string;
  priorityRating?: unknown;
  officerId?: unknown;
  officerName?: unknown;
};
type HeartbeatBody = { itemName?: unknown; officerId?: unknown; officerName?: unknown };
type ClearBody = { itemName?: unknown };
type DismissBody = { itemName?: unknown };
type ResolveWinnerBody = { characterName?: unknown; tier?: unknown; priorityRating?: unknown };
type ResolveBody = { itemName?: unknown; winners?: unknown; officerId?: unknown; officerName?: unknown };

function isPushBody(v: unknown): v is ValidPushBody {
  const b = v as PushBody;
  return (
    typeof b?.itemName === "string" &&
    typeof b?.characterName === "string" &&
    typeof b?.tier === "string" &&
    typeof b?.occurredAt === "string"
  );
}

function key(itemName: string): string {
  return itemName.trim().toLowerCase();
}

export class LiveAuctionSession extends DurableObject<CloudflareEnv> {
  private rounds = new Map<string, Round>();
  // The alarm time currently scheduled, so markSeen can skip re-arming for
  // small forward moves. Resets to null on DO eviction — the next markSeen
  // just re-arms once, which is fine.
  private alarmAt: number | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernatable — quiet viewers don't keep this DO billed as active.
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      this.sweep();
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

      const k = key(body.itemName);
      const now = Date.now();
      const officerId = typeof body.officerId === "string" ? body.officerId : "";
      const officerName = typeof body.officerName === "string" && body.officerName ? body.officerName : "An officer";

      let round = this.rounds.get(k);
      if (!round) {
        // A new round from this officer means the last item they were on is
        // done — sweep THEIR resolved rounds (never anyone else's). This is
        // the "next loot cycle clears the last one" trigger.
        if (officerId) this.sweepResolvedForOfficer(officerId);
        round = {
          itemName: body.itemName.trim(),
          officerId,
          officerName,
          bids: [],
          lastSeenAt: now,
          startedAt: now,
          state: "collecting",
          winners: [],
          resolvedAt: 0,
        };
        this.rounds.set(k, round);
      } else {
        // Whoever pushed most recently is shown as running the round — a
        // duplicate-drop hand-off between officers is rare and they sort it
        // verbally; the point is the name shown is never stale.
        round.officerId = officerId || round.officerId;
        round.officerName = officerName;
        // A push landing on an already-resolved round means this item
        // dropped AGAIN (a fresh loot cycle for the same name) before the
        // resolved card aged out — start it clean rather than appending to
        // the finished one.
        if (round.state === "resolved") {
          round.bids = [];
          round.winners = [];
          round.startedAt = now;
        }
        round.state = "collecting";
        round.resolvedAt = 0;
      }

      const priorityRating = typeof body.priorityRating === "number" ? body.priorityRating : null;
      const tell: LiveBidTell = {
        characterName: body.characterName,
        tier: body.tier,
        occurredAt: body.occurredAt,
        priorityRating,
      };
      // Latest tell per character wins — same "changed my mind" rule as the
      // parser app's ResolveLatestPerCharacter, so this view matches the
      // officer's own review table.
      const i = round.bids.findIndex((b) => b.characterName.toLowerCase() === tell.characterName.toLowerCase());
      if (i >= 0) round.bids[i] = tell;
      else round.bids.push(tell);

      round.lastSeenAt = now;
      this.afterMutation();
      return Response.json({ ok: true }, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // no body is fine
      }
      const { itemName, officerId, officerName } = body as HeartbeatBody;
      const now = Date.now();
      const oid = typeof officerId === "string" ? officerId : "";

      if (typeof itemName === "string" && itemName.trim()) {
        // Bump just this officer's named round.
        const round = this.rounds.get(key(itemName));
        if (round) {
          round.lastSeenAt = now;
          if (typeof officerName === "string" && officerName) round.officerName = officerName;
        }
      } else if (oid) {
        // No item named — bump every round this officer owns.
        for (const round of this.rounds.values()) {
          if (round.officerId === oid) round.lastSeenAt = now;
        }
      }

      this.afterMutation();
      return Response.json({ ok: true }, { status: 200 });
    }

    // Phase 16: the parser calls this on Submit — the round stays visible,
    // now flagged resolved with its winner(s), until RESOLVED_EXPIRY_MS or
    // this officer's next item or a member dismiss.
    if (request.method === "POST" && url.pathname === "/resolve") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      const { itemName, winners, officerId, officerName } = body as ResolveBody;
      if (typeof itemName !== "string" || !itemName.trim()) {
        return Response.json({ error: "itemName is required." }, { status: 400 });
      }
      const now = Date.now();
      const k = key(itemName);
      let round = this.rounds.get(k);
      if (!round) {
        // The round may have already idle-expired while the officer
        // deliberated — recreate a bare one so the winner still shows.
        round = {
          itemName: itemName.trim(),
          officerId: typeof officerId === "string" ? officerId : "",
          officerName: typeof officerName === "string" && officerName ? officerName : "An officer",
          bids: [],
          lastSeenAt: now,
          startedAt: now,
          state: "collecting",
          winners: [],
          resolvedAt: 0,
        };
        this.rounds.set(k, round);
      }
      round.winners = Array.isArray(winners)
        ? winners
            .filter((w): w is ResolveWinnerBody => !!w && typeof w === "object")
            .filter((w) => typeof w.characterName === "string" && typeof w.tier === "string")
            .map((w) => ({
              characterName: w.characterName as string,
              tier: w.tier as string,
              priorityRating: typeof w.priorityRating === "number" ? w.priorityRating : null,
              occurredAt: new Date(now).toISOString(),
            }))
        : [];
      round.state = "resolved";
      round.resolvedAt = now;
      round.lastSeenAt = now;
      if (typeof officerName === "string" && officerName) round.officerName = officerName;
      if (typeof officerId === "string" && officerId) round.officerId = officerId;
      this.afterMutation();
      return Response.json({ ok: true }, { status: 200 });
    }

    // Phase 16: a member clicked "Dismiss" on a resolved card.
    if (request.method === "POST" && url.pathname === "/dismiss") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // no body is fine
      }
      const { itemName } = body as DismissBody;
      if (typeof itemName === "string" && itemName.trim()) {
        this.rounds.delete(key(itemName));
      }
      if (this.rounds.size === 0) {
        this.alarmAt = null;
        await this.ctx.storage.deleteAlarm();
      }
      this.broadcast();
      return Response.json({ ok: true }, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/clear") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // no body is fine
      }
      const { itemName } = body as ClearBody;
      if (typeof itemName === "string" && itemName.trim()) {
        this.rounds.delete(key(itemName)); // one round cancelled/discarded
      } else {
        this.rounds.clear(); // officer app quit — drop all their rounds' worth
      }
      if (this.rounds.size === 0) {
        this.alarmAt = null;
        await this.ctx.storage.deleteAlarm();
      }
      this.broadcast();
      return Response.json({ ok: true }, { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  // Sweeps expired rounds and re-broadcasts if the idle→gone transition
  // changed anything, so a tab left open drops a dead round without the
  // viewer doing anything.
  async alarm() {
    const changed = this.sweep();
    if (this.rounds.size > 0) {
      // Something's still alive — re-arm for the next expiry.
      this.armAlarm(true);
    } else {
      this.alarmAt = null;
    }
    if (changed) this.broadcast();
  }

  // Required by the hibernation API — viewers never send anything and there
  // is no per-socket state to clean up.
  async webSocketMessage() {}
  async webSocketClose() {}
  async webSocketError() {}

  private afterMutation() {
    this.sweep();
    this.armAlarm(false);
    this.broadcast();
  }

  // When this expires, in ms since epoch.
  private expiryOf(round: Round): number {
    return round.state === "resolved"
      ? round.resolvedAt + RESOLVED_EXPIRY_MS
      : round.lastSeenAt + ROUND_EXPIRY_MS;
  }

  // Drops rounds past their expiry. Returns whether anything was removed.
  private sweep(): boolean {
    const now = Date.now();
    let removed = false;
    for (const [k, round] of this.rounds) {
      if (this.expiryOf(round) < now) {
        this.rounds.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  // A fresh round from officer O means their previous item is done — drop
  // the resolved cards they own so the dashboard doesn't pile up. Never
  // touches another officer's rounds (they may still be mid-collection or
  // have their own resolved cards someone's still reading).
  private sweepResolvedForOfficer(officerId: string) {
    for (const [k, round] of this.rounds) {
      if (round.state === "resolved" && round.officerId === officerId) this.rounds.delete(k);
    }
  }

  // Arms the sweep alarm for the soonest round expiry. Debounced: only
  // actually calls setAlarm() when nothing is pending or the pending time
  // is more than ALARM_DEBOUNCE_MS too early (or `force`, from alarm()
  // re-arming itself).
  private armAlarm(force: boolean) {
    let soonest = Infinity;
    for (const round of this.rounds.values()) soonest = Math.min(soonest, this.expiryOf(round));
    if (soonest === Infinity) return; // no rounds
    if (!force && this.alarmAt !== null && soonest - this.alarmAt <= ALARM_DEBOUNCE_MS && soonest >= this.alarmAt) return;
    this.alarmAt = soonest;
    void this.ctx.storage.setAlarm(soonest);
  }

  private statusOf(round: Round): LiveStatus {
    if (round.state === "resolved") return "resolved";
    return Date.now() - round.lastSeenAt < LIVE_TTL_MS ? "live" : "idle";
  }

  private stateMessage(): ServerMessage {
    // collecting rounds (live then idle) before resolved, each group by
    // start order — the dashboard reads top-left = most active.
    const rank = (r: Round) => (r.state === "resolved" ? 2 : this.statusOf(r) === "live" ? 0 : 1);
    const rounds: RoundView[] = [...this.rounds.values()]
      .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)
      .map((r) => ({
        itemName: r.itemName,
        officerName: r.officerName,
        bids: r.bids,
        winners: r.winners,
        status: this.statusOf(r),
        lastSeenAt: r.state === "resolved" ? r.resolvedAt : r.lastSeenAt,
      }));
    return { type: "state", rounds };
  }

  private broadcast() {
    const encoded = JSON.stringify(this.stateMessage());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(encoded);
      } catch {
        // a dead socket the hibernation API hasn't reaped yet — ignore
      }
    }
  }
}
