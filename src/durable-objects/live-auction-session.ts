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
// no signal (an abandoned collection nobody finalized). A **resolved** round
// is never swept by another round starting, and stays on the board until a
// member dismisses it, the officer app clears it (/clear on quit), or
// RESOLVED_EXPIRY_MS (12h) elapses — post-live-test-1 LT-32: a raid's worth
// of resolved cards should clear itself overnight so the board is empty by
// the next session. (Leader call 2026-09-04 had removed the older 20-min
// auto-expiry so people could review at their own pace; 12h keeps that
// review window generous while still self-cleaning.)
const LIVE_TTL_MS = 90_000;
const ROUND_EXPIRY_MS = 300_000;
const RESOLVED_EXPIRY_MS = 12 * 60 * 60 * 1000;

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
  // When a real bid tell last landed (NOT bumped by a heartbeat). A
  // collecting round's expiry is measured from this, so an officer's
  // parser that keeps heartbeating a round it never finalized can't pin
  // it on the board forever — see expiryOf.
  lastBidAt: number;
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
type ClearBody = { itemName?: unknown; officerId?: unknown };
// `userId` present ⇒ a per-viewer dismiss (LT-32): hide this resolved round
// for that account only. Absent ⇒ the legacy global force-clear (not wired
// in the UI; kept as an officer escape hatch).
type DismissBody = { itemName?: unknown; userId?: unknown };
type ResolveWinnerBody = { characterName?: unknown; tier?: unknown; priorityRating?: unknown };
type ResolveBidBody = { characterName?: unknown; tier?: unknown; priorityRating?: unknown; occurredAt?: unknown };
type ResolveBody = { itemName?: unknown; winners?: unknown; bids?: unknown; officerId?: unknown; officerName?: unknown };

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

// ctx.storage key prefix for a persisted resolved round — see the
// constructor's comment for why only resolved rounds get this.
const RESOLVED_STORAGE_PREFIX = "resolved:";

// ctx.storage key for one viewer's dismissal of one round:
// `dismiss:<userId>|<roundKey>` → the dismiss timestamp (ms). Persisted so
// a dismiss survives the viewer's refresh AND this DO being evicted, which
// plain per-browser localStorage never did reliably (post-live-test-1
// LT-32). `|` separates the two parts — better-auth user ids never contain
// it. Cleared when the round leaves the board (12h sweep / re-drop /
// officer clear), so keys don't accumulate and a same-named future drop
// starts un-dismissed for everyone.
const DISMISS_STORAGE_PREFIX = "dismiss:";

export class LiveAuctionSession extends DurableObject<CloudflareEnv> {
  private rounds = new Map<string, Round>();
  // Per-viewer dismissals: userId → set of round keys that viewer has
  // hidden. Mirrors the `dismiss:*` ctx.storage keys; hydrated in the
  // constructor and kept in step on every write so broadcast() can filter
  // without touching storage on the hot path.
  private dismissals = new Map<string, Set<string>>();
  // The alarm time currently scheduled, so markSeen can skip re-arming for
  // small forward moves. Resets to null on DO eviction — the next markSeen
  // just re-arms once, which is fine.
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    // Collecting rounds are deliberately never persisted (see the class
    // comment) — losing one on eviction is fine, bounded, and cheap to
    // rebuild from the next push. A RESOLVED round is a different promise:
    // Phase 16 explicitly says it "never times out... stays on the board
    // until a member dismisses it" — but a plain class-field Map does not
    // survive this Durable Object being evicted from memory, which the
    // Hibernatable WebSockets API this class uses (`ctx.acceptWebSocket`)
    // allows even while a viewer's socket stays connected, independent of
    // any dismiss/clear action. That silently broke the "never times out"
    // promise (leader, 2026-09-05: "live bids still seem to disappear
    // without me clearing anything") — every collecting round is cheap and
    // hot-path-frequent (a push every few seconds per officer) so those
    // still skip storage, but a resolve is a single, infrequent write, and
    // hydrating on construction is what makes the "until dismissed"
    // guarantee actually hold across an eviction.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<Round>({ prefix: RESOLVED_STORAGE_PREFIX });
      for (const [storageKey, round] of stored) {
        // Rounds persisted before lastBidAt existed won't carry it. Since
        // LT-32 a resolved round's expiry IS measured from resolvedAt, but
        // keep the fallback honest in case this item goes live again.
        if (typeof round.lastBidAt !== "number") round.lastBidAt = round.startedAt ?? round.lastSeenAt ?? Date.now();
        this.rounds.set(storageKey.slice(RESOLVED_STORAGE_PREFIX.length), round);
      }
      // Per-viewer dismissals (LT-32) — key shape `dismiss:<userId>|<roundKey>`.
      const dismissed = await ctx.storage.list<number>({ prefix: DISMISS_STORAGE_PREFIX });
      for (const storageKey of dismissed.keys()) {
        const rest = storageKey.slice(DISMISS_STORAGE_PREFIX.length);
        const sep = rest.indexOf("|");
        if (sep < 0) continue;
        const userId = rest.slice(0, sep);
        const roundKey = rest.slice(sep + 1);
        let set = this.dismissals.get(userId);
        if (!set) this.dismissals.set(userId, (set = new Set()));
        set.add(roundKey);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      // custom-worker.ts resolves the session and appends ?userId= so the
      // DO can filter this viewer's dismissed rounds out of every frame it
      // sends this socket. Stashed as a hibernation-durable attachment
      // (LT-32) — read back in broadcast().
      const userId = url.searchParams.get("userId") ?? undefined;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernatable — quiet viewers don't keep this DO billed as active.
      this.ctx.acceptWebSocket(server);
      if (userId) server.serializeAttachment({ userId });
      server.send(JSON.stringify(this.stateMessageFor(userId)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      await this.purgeRounds(this.sweep());
      const userId = url.searchParams.get("userId") ?? undefined;
      return Response.json(this.stateMessageFor(userId));
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
        round = {
          itemName: body.itemName.trim(),
          officerId,
          officerName,
          bids: [],
          lastSeenAt: now,
          lastBidAt: now,
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
          round.lastBidAt = now;
          // No longer resolved — drop its persisted copy (or it would
          // reappear stale after a future eviction) AND every viewer's
          // dismissal of the previous drop, so this fresh round shows for
          // everyone, including people who dismissed the last one (LT-32).
          await this.purgeRounds([k]);
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
      round.lastBidAt = now; // a real tell — resets the abandon timer (heartbeats don't)
      await this.afterMutation();
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

      await this.afterMutation();
      return Response.json({ ok: true }, { status: 200 });
    }

    // Phase 16: the parser calls this on Submit — the round stays visible,
    // now flagged resolved with its winner(s), until a member dismisses it
    // (/dismiss) or the officer app clears it (/clear). No auto-expiry.
    if (request.method === "POST" && url.pathname === "/resolve") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      const { itemName, winners, bids, officerId, officerName } = body as ResolveBody;
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
          lastBidAt: now,
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
      // Phase 16 (2026-09-01): the parser sends the full final bid list on
      // resolve — every character who bid, not just the winner(s) — so the
      // dimmed card keeps showing who bid what and at what priority, rather
      // than collapsing to winner-only. Replace whatever the live poller
      // last left in `bids` (it may be stale, or empty if the round
      // idle-expired before the officer finalized). Only replace when a
      // non-empty list actually arrives, so an older parser that sends no
      // `bids` still shows its last live-collected set.
      const resolvedBids = Array.isArray(bids)
        ? bids
            .filter((b): b is ResolveBidBody => !!b && typeof b === "object")
            .filter((b) => typeof b.characterName === "string" && typeof b.tier === "string")
            .map((b) => ({
              characterName: b.characterName as string,
              tier: b.tier as string,
              priorityRating: typeof b.priorityRating === "number" ? b.priorityRating : null,
              occurredAt: typeof b.occurredAt === "string" ? b.occurredAt : new Date(now).toISOString(),
            }))
        : [];
      if (resolvedBids.length > 0) round.bids = resolvedBids;
      round.state = "resolved";
      round.resolvedAt = now;
      round.lastSeenAt = now;
      if (typeof officerName === "string" && officerName) round.officerName = officerName;
      if (typeof officerId === "string" && officerId) round.officerId = officerId;
      // Persist so this survives a DO eviction — see the constructor's
      // comment. One write per resolve (rare — once per finalized item),
      // never on the push/heartbeat hot path.
      await this.ctx.storage.put(RESOLVED_STORAGE_PREFIX + k, round);

      // custom-worker sends a fresh name→priority map post-charge (see its
      // /resolve handler). Re-price every OTHER still-collecting round so an
      // officer picking a winner elsewhere sees this winner's *now* lower
      // priority — not the pre-charge number that would let them sweep a
      // second item before EPGP catches up. The just-resolved round keeps
      // its own bids' snapshot priorities untouched.
      const repriceAll = (body as { repriceAll?: unknown }).repriceAll;
      if (repriceAll && typeof repriceAll === "object") {
        const pr = repriceAll as Record<string, unknown>;
        for (const r of this.rounds.values()) {
          if (r.state !== "collecting") continue;
          for (const b of r.bids) {
            const v = pr[b.characterName.toLowerCase()];
            if (typeof v === "number") b.priorityRating = v;
          }
        }
      }

      await this.afterMutation();
      return Response.json({ ok: true }, { status: 200 });
    }

    // A member clicked "Dismiss" on a resolved card. LT-32: with a `userId`
    // this is a PER-VIEWER dismiss — the round stays on the board for
    // everyone else, just filtered out of this account's frames (and
    // remembered across their refresh / a DO eviction). Without a `userId`
    // it's the legacy global force-clear (kept as an officer escape hatch;
    // not wired into the UI).
    if (request.method === "POST" && url.pathname === "/dismiss") {
      let body: unknown = {};
      try {
        body = await request.json();
      } catch {
        // no body is fine
      }
      const { itemName, userId } = body as DismissBody;
      if (typeof itemName !== "string" || !itemName.trim()) {
        return Response.json({ ok: true }, { status: 200 });
      }
      const k = key(itemName);

      if (typeof userId === "string" && userId) {
        await this.recordDismissal(userId, k);
        this.broadcast();
        return Response.json({ ok: true }, { status: 200 });
      }

      // Global force-clear.
      this.rounds.delete(k);
      await this.purgeRounds([k]);
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
      const { itemName, officerId } = body as ClearBody;
      const oid = typeof officerId === "string" && officerId ? officerId : "";
      if (typeof itemName === "string" && itemName.trim()) {
        // One named round cancelled/discarded (End Round & Review, or the
        // Bids-tab "Clear" button).
        const k = key(itemName);
        this.rounds.delete(k);
        await this.purgeRounds([k]);
      } else if (oid) {
        // Officer app quit with no item named — drop only THAT officer's
        // rounds. It used to be this.rounds.clear(), which wiped every
        // other officer's live round too: during a raid with several
        // officers collecting in parallel, one of them closing their app
        // took the whole board down (leader, 2026-09-07).
        const mine: string[] = [];
        for (const [k, round] of this.rounds) {
          if (round.officerId !== oid) continue;
          this.rounds.delete(k);
          mine.push(k);
        }
        await this.purgeRounds(mine);
      }
      // A bare clear with neither itemName nor officerId is ignored — the
      // idle sweep reaps abandoned collecting rounds, and a resolved one
      // needs an explicit dismiss anyway. Never nuke the guild-wide board
      // on an under-specified request.
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
    const removed = this.sweep();
    if (removed.length) await this.purgeRounds(removed);
    if (this.rounds.size > 0) {
      // Something's still alive — re-arm for the next expiry.
      this.armAlarm(true);
    } else {
      this.alarmAt = null;
    }
    if (removed.length) this.broadcast();
  }

  // Required by the hibernation API — viewers never send anything and there
  // is no per-socket state to clean up.
  async webSocketMessage() {}
  async webSocketClose() {}
  async webSocketError() {}

  private async afterMutation() {
    await this.purgeRounds(this.sweep());
    this.armAlarm(false);
    this.broadcast();
  }

  // When this expires, in ms since epoch. A resolved round now clears
  // itself RESOLVED_EXPIRY_MS (12h) after it was finalized — LT-32, so the
  // board is empty by the next raid without anyone dismissing anything;
  // before that it can still be dismissed per-viewer or cleared by the
  // officer app. A collecting round expires ROUND_EXPIRY_MS after its last
  // real bid tell — NOT after its last heartbeat: an officer who announces
  // a round and walks away with the parser still open keeps heartbeating
  // it, which used to pin it on the board forever (leader, 2026-09-07).
  // 5 min with no new tell means it was abandoned; the officer can still
  // Submit from the parser (that recreates the round with its winner) and
  // a viewer can hide it sooner.
  private expiryOf(round: Round): number {
    return round.state === "resolved"
      ? round.resolvedAt + RESOLVED_EXPIRY_MS
      : round.lastBidAt + ROUND_EXPIRY_MS;
  }

  // Drops rounds past their expiry from the in-memory map. Returns the keys
  // removed so the caller can purge their persisted copy + any per-viewer
  // dismissals (purgeRounds).
  private sweep(): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [k, round] of this.rounds) {
      if (this.expiryOf(round) < now) {
        this.rounds.delete(k);
        removed.push(k);
      }
    }
    return removed;
  }

  // A round is gone for good (12h sweep, officer /clear, global /dismiss,
  // or re-drop over a resolved card): delete its persisted resolved copy
  // and every viewer's per-account dismissal of it, so `dismiss:*` keys
  // don't pile up and a future same-named drop starts un-dismissed for
  // everyone. Called only when something actually left the board — never on
  // the push/heartbeat hot path when nothing expired.
  private async purgeRounds(roundKeys: string[]): Promise<void> {
    for (const k of roundKeys) {
      await this.ctx.storage.delete(RESOLVED_STORAGE_PREFIX + k);
      for (const [userId, set] of this.dismissals) {
        if (!set.delete(k)) continue;
        await this.ctx.storage.delete(DISMISS_STORAGE_PREFIX + userId + "|" + k);
        if (set.size === 0) this.dismissals.delete(userId);
      }
    }
  }

  private isDismissedBy(userId: string | undefined, roundKey: string): boolean {
    return userId !== undefined && (this.dismissals.get(userId)?.has(roundKey) ?? false);
  }

  private async recordDismissal(userId: string, roundKey: string): Promise<void> {
    let set = this.dismissals.get(userId);
    if (!set) this.dismissals.set(userId, (set = new Set()));
    if (set.has(roundKey)) return;
    set.add(roundKey);
    await this.ctx.storage.put(DISMISS_STORAGE_PREFIX + userId + "|" + roundKey, Date.now());
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

  // The board as one viewer sees it: rounds they've dismissed (LT-32) are
  // filtered out. `userId` undefined ⇒ no filtering (an un-attributed
  // socket, or a direct call without ?userId=).
  private stateMessageFor(userId: string | undefined): ServerMessage {
    // collecting rounds (live then idle) before resolved, each group by
    // start order — the dashboard reads top-left = most active.
    const rank = (r: Round) => (r.state === "resolved" ? 2 : this.statusOf(r) === "live" ? 0 : 1);
    const rounds: RoundView[] = [...this.rounds.entries()]
      .filter(([k]) => !this.isDismissedBy(userId, k))
      .map(([, r]) => r)
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
    // Each socket carries its viewer's userId as a hibernation-durable
    // attachment (see /ws). Serialize one frame per distinct dismiss view —
    // in practice most viewers have dismissed nothing and share a single
    // frame; only the few with active dismissals cost an extra JSON.stringify.
    const frames = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      let userId: string | undefined;
      try {
        userId = (ws.deserializeAttachment() as { userId?: string } | null)?.userId;
      } catch {
        userId = undefined;
      }
      const cacheKey = userId ?? "";
      let encoded = frames.get(cacheKey);
      if (encoded === undefined) {
        encoded = JSON.stringify(this.stateMessageFor(userId));
        frames.set(cacheKey, encoded);
      }
      try {
        ws.send(encoded);
      } catch {
        // a dead socket the hibernation API hasn't reaped yet — ignore
      }
    }
  }
}
