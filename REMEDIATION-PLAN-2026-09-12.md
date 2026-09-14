# Seekers Stability, Reliability, and UX Remediation Plan

**Created:** 2026-09-12  
**Status:** Implemented and audited; explicit deferred/live-verification items remain
**Applies to:** `seekers-tracker` and `seekers-epgp-parser`

This is the active implementation plan for post-launch stability, bid
reliability, account claims, responsive UI, workflow, and public-site work.
Read `../PLAN.md` first. That original plan remains authoritative for guild
rules, EPGP behavior, schema history, and architectural constraints. This plan
defines the order of new work and does not override those domain rules.

## Final Audit — 2026-09-14

All required tracker migrations through 0040 are applied to production and
tracker commit `acea4fb` is deployed as Worker version
`461b8656-adf7-4a3e-9783-4b31b4f325e5`. Parser `v0.1.16` is published from
`a319441` with the Windows executable and `SHA256SUMS`; this is the first
release carrying Phase 3's immutable submission ID. Both repositories' `main`
branches are synchronized with origin.

The audit found and corrected three completion overstatements before this
rollout: a concurrent standings refresh could erase a newer dirty marker;
repair could exceed D1's safe parameter count and report markers cleared after
a failure; and the parser could parse an unterminated trailing log line while
omitting the round ID from live update events. The tracker now generation-tags
markers, conditionally clears only the generation it recomputed, repairs in
bounded chunks, returns standings only after a successful refresh, and
normalizes simultaneous identical bid finalizations into one write plus one
replay. Manual ledger insertion, account absorption, and main-swap fees now
mark dirty before their first authoritative write, closing their prior
post-write/no-marker failure window. The account page uses a targeted fresh
standing read.

Post-deploy read-only checks found no pending migrations, no foreign-key
violations, zero dirty markers, and zero EP/GP ledger-to-materialized-total
mismatches. The existing two-minute repair cron was also directly observed
clearing a global marker and restoring a temporarily drifted production read
model before this deployment.

Items intentionally still open are task 1.5's real removed-member/revoked-key
checks; task 2.2's higher-risk single-pass parser redesign; the remaining task
2.6 scenario matrix; optional Phase 4B; and the credential/representative-
traffic checks left open in the production checklist. These are not hidden
implementation, migration, or deployment failures. For tonight, officers must
confirm the installed app reports `v0.1.16` before relying on immutable retry
protection, and should use a fresh or rotated EQ log because parsing CPU/memory
still scales with accumulated log size until task 2.2 is designed.

## Confirmed Product Decisions

- One officer approval claims the complete linked main/alt/mule player account.
- Mobile work starts with the global shell, then covers core routes.
- The landing page will use a Norrath editorial direction with authentic guild
  or game imagery and restrained motion.
- The landing page will offer direct Discord sign-in; `/login` remains the
  protected-route, error, and retry fallback.
- The Roster becomes the directory into account management. Account pages own
  mutations; Admin retains queues, onboarding, operations, and settings.
- Do not put a direct D1 Time Travel restore button in the main application.
  Prefer auditable domain-specific reversals and guarded operator recovery.
- Upgrade the Better Auth runtime package family to 1.7.2 first. Move to 1.7.4
  and remove the temporary account issuer schema in a later isolated phase.

## Operating Rules

These rules apply to every phase without needing to be repeated by the user.

1. Inspect Git status, recent commits, and the complete affected diff before
   editing or committing. Preserve unrelated work.
2. Implement one logical task at a time and make a focused commit after its
   required verification passes.
3. Add regression coverage for every reproduced defect. Use realistic local
   data and runtime tests in addition to typechecking.
4. Follow local-first D1 testing. Never test destructive migrations, decay, or
   recovery against production.
5. For tracker schema changes: generate and review the migration, apply it
   locally, verify, apply it remotely, and only then deploy dependent code.
6. For parser changes: run Go tests and vet, regenerate Wails bindings when an
   exported method changes, build the frontend, and run a full Wails build.
7. Keep tracker and parser commits in their respective repositories. Record
   matching SHAs when a task spans both repositories.
8. Do not release a parser version until its required tracker API is deployed
   and backward-compatible rollout order is verified.
9. Deploy stability phases independently and observe production before mixing
   in unrelated changes. Record Worker versions, parser tags, and smoke tests.
10. Update this checklist and relevant durable documentation as work lands.
11. Stop for unresolved product choices, destructive recovery, conflicting
    concurrent edits, unavailable secrets, or a failed safety gate. Routine
    implementation, testing, commits, pushes, releases, and required deploys
    proceed without repeated reminders.

## Phase 0: Website Freeze Containment and Root Fix

The 2026-09-12 production recurrence narrowed the freeze to
`auth.api.getSession()` after auth initialization and with no D1 statement
pending. It occurred during concurrent `_rsc` account-page prefetch waves.

Better Auth 1.7.1 also has a directly relevant upstream defect: 1.7.2 changed
`@better-auth/core` export-condition priority so Cloudflare bundles use the
native `workerd` async-context implementation instead of the generic edge
implementation when multiple runtime conditions are enabled.

- [x] 0.1 Add precise async request-state/session boundary instrumentation and
  correlation IDs around `auth.api.getSession()`. (`db77e4a` — per-request
  `x-request-id` stamped in custom-worker.ts, folded into every
  `[hang]`/`[slow]`/`[perf]` line and into session.ts's `authContext`/
  `getSession` stage labels; `checkAsyncContextImplementation()` boot log.)
- [x] 0.2 Disable automatic Next prefetch on high-cardinality account links in
  Roster, Progression, account-member lists, and other collection views.
  (`f03942d`.)
- [x] 0.3 Align the runtime Better Auth package family on 1.7.2 and lock the
  resolved versions. Keep `better-auth-cloudflare` compatibility explicit.
  (`db77e4a` — exact-pinned better-auth/@better-auth/api-key/
  @better-auth/drizzle-adapter/better-auth-cloudflare, plus an `overrides`
  entry for the transitive `@better-auth/core`, which npm otherwise hoisted
  to 1.7.4 — ahead of the deliberately-deferred Phase 11 upgrade.)
- [x] 0.4 Verify the production bundle selects the `workerd` async-hooks export,
  not `pure.index.mjs`. (`db77e4a` — confirmed two ways: diffed the raw
  published package.json of @better-auth/core 1.7.1 vs 1.7.2 directly
  [1.7.2 moves `workerd` ahead of `edge` in the `./async_hooks` export
  map], and the built OpenNext bundle logs `[boot] async-context:
  AsyncLocalStorage (real, per-continuation isolation)` under a real
  `wrangler dev --local` run. Also found and fixed a second, independent
  contributor: `nodejs_compat` was missing from wrangler.jsonc entirely —
  required by @opennextjs/cloudflare's own template — without which
  `import("node:async_hooks")` can't resolve at runtime regardless of the
  package version.)
- [x] 0.5 Add a bounded failure path so a stalled session lookup produces a
  recoverable error instead of an indefinitely frozen navigation. Do not hide
  or incorrectly convert the fault into a logged-out session. (`db77e4a` —
  `getSession()` races its whole authContext+getSession sequence against a
  12s deadline that throws `SessionLookupTimeoutError` instead of resolving
  null, propagating to the existing `(app)/error.tsx`/`global-error.tsx`
  "Reload / Try again" boundaries instead of ever reaching a
  `redirect("/login")`.)
- [x] 0.6 Exercise concurrent authenticated RSC requests, aborted requests,
  repeated navigation, and a prefetch-like account-page burst locally.
  (`db77e4a` — real signed session cookie minted from inside a running
  local server's own auth context; 40 concurrent prefetch-flavored
  requests to distinct account pages, 3×7 concurrent authenticated
  document requests across 7 routes, 15 client-aborted + 10 normal
  requests mixed, 20 concurrent hits on one route — all clean, no
  `[hang]`, server responsive throughout.)
- [x] 0.7 Run tracker typecheck/build/runtime smoke tests, deploy this phase by
  itself, and monitor Workers Logs before proceeding. Typecheck/build/local
  smoke tests done (see `db77e4a`'s commit message). **Deployed 2026-09-12**
  — Worker version `d027a1d5-a475-4700-8bb1-e8001ab60b24`, `buildId` = commit
  `d4bea3a` (confirmed via `/api/health`). Note on how this deploy actually
  happened: the user's own `npm run deploy` failed with wrangler printing its
  `deploy [path]` usage help instead of deploying (root cause not yet found —
  a plain `wrangler deploy`/`wrangler deploy --dry-run` both work fine, so the
  problem is specific to the `opennextjs-cloudflare deploy` wrapper's
  invocation, not the build artifact or wrangler.jsonc). While diagnosing
  read-only, the assistant ran `npm exec wrangler deploy --dry-run` to
  reproduce the wrapper's invocation shape safely — without a `--` separator,
  npm's own arg parsing silently dropped `--dry-run` before it reached
  wrangler, so it deployed for real. This was a mistake (deploys were
  supposed to be off-limits for the assistant this session) and is recorded
  as such; see the session's own feedback note. The resulting deploy was
  verified sound after the fact rather than discarded, since it was exactly
  the code the user was already trying to deploy.
  Post-deploy verification (read-only): `/`, `/login` 200; `/roster`,
  `/progression`, `/access-denied` 307 unauthenticated;
  `www.seekersofsouls.com` and `seekers.fetchinglogic.com` 301 to the
  canonical apex; a live `wrangler tail` during several requests showed
  `[boot] async-context: AsyncLocalStorage (real, per-continuation
  isolation)` on every cold isolate and no `[hang]`/errors.

**Exit gate:** no request-state export mismatch — **confirmed live** (boot
log above). Account collection views do not issue automatic account-page
prefetch storms — code fix live (`f03942d`), not independently re-verified
against real browser prefetch traffic. Canceled concurrent RSC tests
settle — verified locally pre-deploy (`db77e4a`). Production has sufficient
clean authenticated traffic after the deployment — **needs ongoing real
officer usage to confirm**, not something a few synthetic requests can
establish; keep watching `wrangler tail` during the next few real sessions.

## Phase 1: Guild Removal and Authorization Safety

Removal currently demotes `users.role` but can leave a higher `players.role`.
On login, `syncAccountRole()` lets the higher role win. A login after
`departedAt` is also treated as a rejoin without proving a Discord leave/rejoin
transition.

- [x] 1.1 Update player and user roles consistently during removal.
  (`a0e0a4b` — removal now drops `players.role` to "member" unconditionally,
  not just `users.role` when a login exists; previously syncAccountRole's
  "higher wins" login hook silently restored the pre-removal role.)
- [x] 1.2 Keep `departed` accounts denied until an explicit leader
  reinstatement. Do not use a later login timestamp as proof of rejoining.
  (`a0e0a4b` — `isMemberAllowed` no longer treats a login after
  `departedAt` as a rejoin; departed is now an unconditional denial.)
- [x] 1.3 Preserve API-key revocation and verify a removed account cannot mint
  or use an officer key. (Already correct — `revokeApiKeysForUser` +
  `verifyOfficerApiKey`'s live `canManageEpgp` re-check — but it depended
  on 1.1's role-sync fix to actually hold on the removed account's next
  login; verified end-to-end by the new script.)
- [x] 1.4 Cover member/officer removal, login after removal, explicit
  reinstatement, WebSocket access, self-removal, and last-leader protection.
  (`scripts/verify-guild-removal.ts`, `npm run verify:guild-removal`,
  21/21 checks pass against local D1.)
- [ ] 1.5 Deploy independently and verify browser and officer API denial.
  No migration needed (no schema change). **Deployed 2026-09-12** — same
  Worker version as Phase 0 task 0.7 (`d027a1d5-a475-4700-8bb1-e8001ab60b24`,
  `buildId` = `d4bea3a`; see that task for the deploy circumstances).
  **Still open**: confirming `/access-denied` for an actually-removed account
  and a stale officer key's 403 against production — both need a real
  removed member's session / a real revoked key, which this session has no
  credentials for (the same Discord-OAuth gap noted throughout this plan).
  A leader/officer with real access should run that check before this task
  is checked off.

## Phase 2: Incremental Desktop Log Capture

The current parser repeatedly loads the complete EQ log with `os.ReadFile`.
Announcement and live-bid pollers rescan it independently, and the live loop
parses the same content more than once. A nearly 1 GB officer log makes this a
confirmed production failure mode.

- [x] 2.1 Build one append-only tailer with file identity, byte offset, partial
  line buffering, and truncation/replacement handling. (`dafc3cc`,
  `seekers-epgp-parser` — `internal/logtail`. `Tailer.Read()` seeks to the
  last-read offset and only reads newly appended bytes; `os.SameFile`
  [not path/mtime] plus a shrunk-size check trigger a reset on truncation
  or a same-path file replacement. Returns a zero-copy `unsafe.String`
  view over a geometrically-grown buffer rather than copying the whole
  accumulated content on every call — an earlier version did that copy
  and it alone cost ~20ms per poll on a 100 MB fixture, defeating the
  point; fixed before committing, see task 2.7's numbers.)
- [ ] 2.2 Parse each appended line once and fan events into announcement,
  attendance, and active bid-round state. **Partially done, deliberately
  scoped down** (`63b715a`): `app.go`'s `readLog()` now goes through one
  shared tailer per `logPath`, so the announcement watcher and the
  live-bid poller no longer each independently re-read the whole file —
  the confirmed failure mode (2 pollers × full-file `os.ReadFile` on a
  ~1 GB log) is fixed. A true single-pass line-by-line state machine
  (rewriting `internal/parse`'s regex/window-based
  attendance/announcement/bid scanners into incremental parsers) was
  **not** attempted — the regression risk against this app's many
  documented edge-case fixes (whoBlockWindow, announcement session-gap
  merging, cancel/supersede handling, park/switch rounds) outweighed the
  remaining CPU win once the I/O side was fixed. Revisit only if profiling
  in the field shows the per-tick regex re-scan itself (not the disk read)
  is a real cost on a very large log.
- [x] 2.3 Preserve bounded startup lookback and the existing rule that active
  character logs do not switch during a live bid round. (Unaffected by
  `dafc3cc`/`63b715a` — neither the lookback windows in
  `ListAttendanceSnapshots`/`CaptureBids` nor `startActiveLogWatch`'s
  `pendingLogPath` deferral while `roundItem != ""` were touched. Verified
  directly: a throwaway `app_manual_test.go` captured attendance, appended
  more log content, re-captured through the same tailer, then switched to
  a different file mid-session and confirmed the new file's content
  resolved cleanly — deleted before committing, per this repo's own
  convention.)
- [x] 2.4 Decouple HTTP delivery from file ingestion using a bounded,
  coalescing latest-snapshot queue, short request deadlines, and capped retry
  backoff. Mark a snapshot delivered only after success. (`63b715a` —
  `livebidpush.go`. `startLiveBidPush`'s single sequential loop [read log,
  emit local UI event, push over HTTP] was split in two: the ingestion
  loop now only reads/emits locally and hands the latest snapshot to a
  `livePushMailbox` [single-slot, coalescing — a newer snapshot always
  supersedes an older undelivered one, never queues behind it];
  `runLivePushDelivery` drains it on its own goroutine with an 8s
  per-attempt deadline and up to 3 capped retries [1.5s backoff],
  `livePushStatus.markDelivered` only ever called on a genuine success.
  Before this, a slow/hung site connection delayed the officer's OWN live
  view of their round, not just the site's.)
- [x] 2.5 Surface current log size, last successful push, pending retry, and
  delivery errors without blocking local capture or UI updates. (`63b715a`
  — backend: `App.GetLogTailStatus()`/`App.GetLiveBidPushStatus()`.
  `817d73c` — frontend: `BidsPanel` polls `GetLiveBidPushStatus` every 3s
  while a round is live [a local, in-memory call, not a network request]
  and shows "connecting to site…" / "✓ live board synced" / "⚠ site
  connection trouble — retrying" next to the round header;
  `SettingsPanel` shows how much of the followed log has been read and how
  many times the tailer reset, under the EverQuest folder section.
  Non-blocking by construction from 2.4's split, independent of display.)
- [ ] 2.6 Test partial lines, same-second tells, repeated text, cancellations,
  truncation, replacement, character swaps, parked rounds, stalled HTTP, and
  recovery. **Partially covered**: partial lines/truncation/replacement/
  concurrent readers (`internal/logtail/logtail_test.go`, `dafc3cc`) and
  stalled-HTTP/retry-recovery/delivered-only-on-success
  (`livebidpush_test.go`, `63b715a`) are new tests added this phase.
  `a319441` tightened the partial-line case: an unterminated trailing record is
  now buffered and withheld from every parser until its newline arrives.
  Same-second tells, repeated text, cancellations, character swaps, and
  parked rounds are pre-existing `internal/parse` behavior this phase
  didn't touch (see 2.2) — already exercised by the existing
  `attendance_test.go`/`bids_test.go`, which stayed green throughout and
  weren't re-verified against new scenarios here.
- [x] 2.7 Generate a temporary large-log fixture and prove append latency is
  based on new bytes rather than total file size. (`dafc3cc` —
  `TestTailer_LargeLog_IncrementalReadIsFast`: 100 MB fixture, full read
  ~50ms, a 50-byte incremental append read back in ~20-40µs — roughly
  1000-2000x faster, and the test asserts the incremental read stays under
  1/4 of the full-read cost rather than a fixed wall-clock threshold, to
  stay meaningful on a slower machine.)
- [x] 2.8 Run Go tests/vet, real `App` serialization tests, frontend build,
  binding generation as needed, and full Wails build. Done for everything
  landed so far (`dafc3cc`, `63b715a`): `go build`/`go vet`/`go test`
  clean, `go test -race ./...` clean including a dedicated concurrent-
  readers test; a throwaway `app_manual_test.go` exercised the real
  `CaptureAttendance`/`GetLogTailStatus` methods end-to-end then was
  deleted; `wails3 generate bindings` regenerated `app.ts`/`index.ts`/
  `models.ts` for the two new methods; `frontend/npm run build` and a full
  `wails3 build` both succeeded; the built binary launched without a crash
  (headless smoke check only — no GUI click-through). Re-run this gate
  again once 2.2/2.5/2.6 close out the rest of the phase.
- [x] 2.9 Release through the tagged Windows workflow after compatible server
  behavior is live, then verify updater delivery. (`v0.1.15` first shipped the
  incremental tailer/status UI; `v0.1.16`, published 2026-09-14 from `a319441`,
  also carries immutable submission IDs, completed-line buffering, and live
  round-ID propagation. The tag workflow succeeded and published the Windows
  executable plus `SHA256SUMS`; GitHub latest-release/updater discovery points
  at this release.)

## Phase 3: Atomic and Idempotent Bid Finalization

Finalization currently inserts the loot event, bid chunks, winner pointer, GP
charges, and standings refresh in separate operations. A timeout can leave
partial authoritative data, while retries rely on an item/time heuristic.

- [x] 3.1 Introduce a client-generated immutable round/submission ID and carry
  it through parser live messages and final submission. (`406070f`,
  `seekers-epgp-parser` — `CaptureBids`/`SwitchBidRound` mint a UUID via
  `crypto/rand` [no new dependency] the moment a round opens, on
  `BidRound.RoundID`; carried through every live/parked/reviewed round the
  frontend holds and into `SubmitBids` as `BidsRequest.SubmissionID`. A
  manual round mints its own client-side with `crypto.randomUUID()`. Exists
  because `officerapi.sendWithRetry` already silently retries a finalize
  once on a transport error or a 502/503/504 with the identical body — a
  response lost after the write actually succeeded needs a way to be
  recognized as the same submission, not a fresh one.)
- [x] 3.2 Add the required unique schema constraint and preserve compatibility
  during tracker-first/parser-second rollout. (`44f3ed1` — migration 0036,
  `loot_events.submission_id`, nullable + a unique index [SQLite permits any
  number of NULLs in a unique index]. Plain `ADD COLUMN` + `CREATE UNIQUE
  INDEX`, no table rebuild. Applied `--local`, then **applied to remote D1
  and deployed 2026-09-13** by the user (this session's auto-mode has no
  access to either) — `wrangler d1 migrations apply seekers-of-souls
  --remote` confirmed the column + unique index live on remote before
  `npm run deploy` shipped the code. Worker version
  `608841c8-b229-4395-930b-c81c6c24a30b`, bundle 2721.49 KiB gzipped;
  `buildId` = commit `676a693` (confirmed via `/api/health`). Read-only
  post-deploy checks: `/`, `/login` 200; `/roster`, `/live-bids` 307
  unauthenticated; `POST /api/officer/bids` with no key 401 — no
  regression. Tracker-first rollout as designed, so an old parser build
  that never sends a submissionId keeps working unchanged.)
- [x] 3.3 Resolve and validate every character, player, tier, winner, and GP
  amount before writing. (`44f3ed1` — every entry is resolved in
  `finalizeBidRound` before any statement is built; previously the
  `loot_events` row was inserted first and unmatched/invalid entries were
  only discovered afterward, so an all-invalid payload could still leave a
  bare loot event behind. Now nothing is written at all in that case.)
- [x] 3.4 Commit loot, bids, winner relationship, and GP ledger rows in one D1
  transactional batch. (`44f3ed1` — `src/lib/epgp/bid-finalization.ts`'s
  `finalizeBidRound`, one `db.batch()` call. Each bid's `loot_event_id` and
  the loot event's own `winning_bid_id` resolve via a `(SELECT id FROM
  loot_events WHERE submission_id = ?)` subquery rather than a JS-side id
  from an earlier statement, since `batch()` sends the whole array as one
  request. `last_activity_at` bumps and the standings refresh stay outside
  the atomic batch on purpose — derived/display state, Phase 4's domain,
  not the authoritative ledger rows this task is about.)
- [x] 3.5 Make retries return the existing successful result for the same
  submission ID without applying GP again. (`44f3ed1` — a `submissionId`
  that already exists on a `loot_events` row short-circuits before
  anything else, including the item/time heuristic below, and returns the
  original result with `replay: true`. Verified by
  `scripts/verify-bid-finalization.ts` Scenario B: a byte-identical retry
  returns the same `lootEventId` and leaves exactly one `gp_ledger` row.)
- [x] 3.6 Retain item/time duplicate detection only as an officer warning for a
  distinct possible duplicate drop. (`44f3ed1` — unchanged in behavior
  [still a soft 409 requiring `confirmDuplicate`], but now understood as a
  secondary check for a genuinely different submission that merely looks
  like a same-item near-time duplicate — task 3.5's submissionId check is
  what actually protects a mechanical retry now. Verified by Scenario C: a
  *different* submissionId for the same item/time is still rejected without
  confirmation and writes nothing, then succeeds as a genuinely new loot
  event once confirmed.)
- [x] 3.7 Keep all application-defined Durable Object calls out of Next Route
  Handlers; live resolve/clear remains in `custom-worker.ts`. (Confirmed
  still true, not re-derived — this route never touched the DO before this
  phase and still doesn't; see the route's own comment and CLAUDE.md's
  "Hard-won gotchas".)
- [x] 3.8 Cover mid-write failures, client retry, duplicate drops, multiple
  winners, invalid rows, and standings-refresh failure. (`44f3ed1` —
  `scripts/verify-bid-finalization.ts`, `npm run verify:bid-finalization`,
  27/27 checks against local D1: a normal atomic write with a standings
  refresh; a same-submissionId retry; the item/time heuristic on a
  different submission; an unresolvable winner name rejecting before any
  write [mid-write-failure-shaped: task 3.3 means there's no partial write
  to leave behind]; a multi-winner duplicate-drop round with one unmatched
  non-winner reported but not fatal. Needed an explicit `await
  proxy.dispose()` before the snapshot restore in the script's own
  `finally` — without it, a first run left a stale test row behind even
  after "Restored snapshot" had printed, because the still-open Miniflare/
  D1 handle flushed its own pre-restore state back over the file
  afterward; same fix `verify-guild-removal.ts`/`verify-global-decay.ts`
  already carry.)

## Phase 4: Fresh and Recoverable Standings

`player_epgp_totals` is the correct read model and remains in place. The
avoidable weaknesses are a 10-second per-isolate memory cache and a refresh
failure that can leave drift until the nightly rebuild.

- [x] 4.1 Remove or bypass the module cache for strict-freshness paths.
  (`2e9327c` — `getStandingsForPlayers` reads `player_epgp_totals` directly,
  never through the 10s whole-table `standingsCache`. The whole-table cache
  itself stays for `getStandings()`'s roster/dashboard/Totals-tab callers —
  removing it outright would reintroduce the per-request D1 read cost it
  was added to solve for a display list; every strict-freshness caller
  [a mutation's own affected player(s)] now goes through the bypass
  instead.)
- [x] 4.2 Add targeted standing reads for one or several player IDs.
  (`2e9327c` — `getStandingsForPlayers(db, playerIds)`, chunked at 90 ids,
  index-seeked `WHERE player_id IN (...)`.)
- [x] 4.3 Return affected current standing rows from successful mutations where
  the initiating client can update immediately. (`2e9327c` — every ledger-
  mutating action/route [`addLedgerEntry`/`updateLedgerEntry`/
  `deleteLedgerEntry`, `POST /api/officer/manual-entry`, `POST
  /api/officer/attendance`, `finalizeBidRound`/`POST /api/officer/bids`]
  now returns the affected player's fresh standing alongside its existing
  result. Data-layer only this phase — no current UI reads the new field
  yet, same explicit split Phase 2 task 2.5 used for its own frontend
  follow-up; this app's mutation components uniformly use `router.refresh()`
  today, not a client-side merge pattern, so wiring a UI consumer wasn't
  invented here without a caller that needs it yet.)
- [x] 4.4 Add durable dirty-player/global markers in the same transaction as
  authoritative ledger mutations. (`2e9327c` — migration 0037,
  `standings_dirty` [scope `"all"` or `"player:<id>"`] — **applied to remote
  D1 2026-09-13** via `wrangler d1 migrations apply seekers-of-souls
  --remote`, table confirmed live; code not yet deployed, see task 4.7's
  deploy note below. `dirtyMarkerStatements`
  rides in the SAME `db.batch()` as the ledger rows wherever one already
  exists [bid-finalization's one atomic batch; each `insertEpLedgerBatch`
  chunk]; `markStandingsDirty` writes a fast adjacent statement immediately
  before/after the write where the codebase's own existing writes for that
  path aren't already one transaction [decay.ts's per-row loop, `players.ts`'s
  absorb/main-swap-fee/reverse] — matching that code's own documented
  not-one-transaction-but-structured-to-stay-recoverable pattern rather than
  introducing new transactional guarantees those paths don't otherwise have.)
- [x] 4.5 Clear dirty markers only after successful materialization and add a
  frequent lightweight repair pass. Retain the nightly full drift check.
  (`2e9327c` — `refreshStandings` deletes exactly the markers it covers once
  it actually succeeds; `repairDirtyStandings` is the repair pass, wired
  into the existing `*/2 * * * *` cron in `custom-worker.ts` alongside the
  keep-warm ping [independent `ctx.waitUntil`, doesn't block or get blocked
  by it]. The nightly 09:17 UTC `rebuildAllStandings` cron is untouched —
  still the full-table safety net.)
- [x] 4.6 Ensure identity/account mutations cannot forget to refresh or mark
  affected standings. (`2e9327c` — every direct `refreshStandings` call site
  outside `standings.ts` itself now goes through `markStandingsDirty` +
  `settleStandings` instead, which never throws back into the caller's
  mutation on a recompute failure. `absorbStandalonePlayer` [account
  absorption during a claim/link] now marks the target player dirty at the
  actual mutation site rather than relying on every caller to remember.)
- [x] 4.7 Verify attendance, bids, manual entries, ledger edits, settings,
  decay, account absorption, and main-swap fees. (`2e9327c`/`10e1f71` — new
  `scripts/verify-standings-resilience.ts` [`npm run
  verify:standings-resilience`], 24/24 against local D1: dirty-marker
  durability and scoping, clean clearing on success, the repair pass
  healing a marker with no materialized row at all, a global marker's
  repair subsuming an unrelated player-scoped one, `settleStandings` never
  throwing, `getStandingsForPlayers` bypassing the whole-table cache, and
  the real `insertLedgerEntry`/`attachCharacterToPlayer`/
  `swapMainCharacter`+`reverseMainSwap` entry points end to end. Existing
  `verify:bid-finalization` [27/27], `verify:guild-removal` [21/21],
  `verify:global-decay`, and `verify:attendance-minimum` all still pass
  unchanged — confirms the dirty-marker plumbing didn't disturb atomicity
  or the bids/decay/departure-wipe paths it now also covers. `npm run
  verify` stayed at its pre-existing 9/13 baseline, confirmed identical
  against the pre-Phase-4 code via `git stash` — the 4 failures are known
  local seed drift from earlier sim sessions, not a regression.)

**Deployed 2026-09-13** — migration 0037 applied to remote D1, then `npm
run deploy` by the user (this session's auto-mode has no access to
either). Worker version `6c4ad7ae-6eda-433d-8441-ceae48ce9f23`, bundle
2723.52 KiB gzipped (well under the 3072 KiB Free-plan cap), `buildId` =
commit `b09e880` (confirmed via `/api/health`). Read-only post-deploy
checks: `/`, `/login` 200; `/roster`, `/live-bids` 307 unauthenticated;
`POST /api/officer/bids` with no key 401 — no regression. A short
`wrangler tail` sample during a couple of live requests showed clean `Ok`
statuses, no `[hang]`/errors. **Still open**: no real officer traffic has
exercised the dirty-marker/repair path in production yet (a refresh
actually failing and the 2-minute cron healing it) — that needs ongoing
real usage to observe, not something a few synthetic requests establish.

**Audit hardening deployed 2026-09-14** — `acea4fb`, migration 0040, Worker
version `461b8656-adf7-4a3e-9783-4b31b4f325e5`. Migration 0040 adds a marker
generation token. Refreshes snapshot generations before reading ledgers and
conditionally clear only those exact generations, so a concurrent write can no
longer be erased by an older refresh. Repair batches are bounded at 40 players
and report only markers actually removed. The resilience harness now induces a
real refresh failure and uses a trigger to replace a marker during an upsert,
proving the newer generation survives. A concurrent bid-finalization scenario
also proves two same-ID requests create one event/charge and one replay. Local
Phase 4/decay/removal/attendance gates, production build, OpenNext dry run, and
Playwright 81/81 pass. Production has zero dirty markers, zero standings
mismatches, and zero foreign-key violations after deployment.

### Optional Phase 4B: Live Standings Fan-Out

Do this only after Phase 4 correctness is proven and measurements justify it.

- [ ] 4B.1 Add a guild-wide `StandingsHub` Durable Object as a fan-out layer,
  never as the source of truth.
- [ ] 4B.2 Publish a monotonically increasing revision and changed player rows
  after committed refreshes.
- [ ] 4B.3 Let open Roster, Dashboard, and Account views patch affected rows or
  request a targeted refresh.
- [ ] 4B.4 Notify live auctions when affected bidders need repricing.
- [ ] 4B.5 Cover eviction/rehydration, reconnect, missed revisions, and stale
  client recovery.

## Phase 5: Account-Level Character Claims

- [x] 5.1 Treat `players.userId` as account ownership source of truth while
  keeping `characters.ownerId` synchronized for existing authorization/UI.
  (`978e8b6` — `syncCharacterOwnership` in `src/lib/players.ts`: one UPDATE
  setting `characters.owner_id` to the player's `user_id` for every
  character sharing that `player_id`. Called from `resolvePlayerForUser` on
  every login [both the "already linked" and "first-claim" branches — cheap
  self-heal, same pattern `syncAccountRole` already uses] and from
  `attachCharacterToPlayer` after every attach/absorb.)
- [x] 5.2 Let a member select one unclaimed character but create one pending
  claim for its linked player account. (`978e8b6` — `requestClaim`
  [characters/claim/actions.ts] resolves the target character's current
  `player_id` and blocks a second pending claim by the same requester on
  ANY character already in that group, not just the exact one picked.)
- [x] 5.3 Show the complete main/alt/mule group in member and officer review UI.
  (`978e8b6` — `/characters/claim` lists each unclaimed character's group
  members under it ["Claiming this also claims…"]; `/admin/claims` shows
  the same under each pending request ["Approving also attaches…"]. New
  `listPlayerGroupCharacters` helper backs the verification script; the two
  list pages batch their own group lookups directly since they span many
  rows at once.)
- [x] 5.4 On approval, assign the player account and synchronize ownership for
  every linked character atomically. (`978e8b6` — `attachCharacterToPlayer`'s
  `syncCharacterOwnership` call covers the complete RESULTING group after
  any absorb, as one atomic UPDATE statement, not just the character named
  in the call; its main-pointer bootstrap was also generalized to look at
  the whole group's "main"-typed character instead of only the one just
  attached, so claiming an alt/mule first still sets
  `players.main_character_id` immediately rather than waiting on the
  nightly `reconcileMainPointers` cron.)
- [x] 5.5 Resolve duplicate pending claims across the complete group without
  deleting claim history. (`978e8b6` — new `resolveOtherPendingClaimsForGroup`,
  `src/lib/claims.ts`, called from `approveClaim`: every other pending claim
  on a character now sharing the approved group's `player_id` is resolved —
  denied [not deleted] if it's a different requester.)
- [x] 5.6 Refuse silent transfers where the account or a linked character is
  attached to another real user/Discord identity. (`978e8b6` —
  `attachCharacterToPlayer` centrally refuses when the character's current
  group has a `user_id` or `discord_id` that isn't the claimant's own,
  replacing three duplicated ad hoc checks in `claimAlt`/
  `linkCharacterToAccount`/`assignCharacterToUser` with one.
  `assignCharacterToUser` no longer writes `owner_id` before that check can
  run, so a refused claim leaves no partial write.)
- [x] 5.7 Consolidate existing duplicate pending requests safely.
  (`978e8b6` — the same `resolveOtherPendingClaimsForGroup` call: the SAME
  requester's other pending claim on a sibling character becomes approved
  with an explanatory decision note, rather than left pending or wrongly
  denied.)
- [x] 5.8 Cover standalone characters, imported groups, conflicting ownership,
  concurrent approvals, denial, and historical single-character claims.
  (`978e8b6` — `scripts/verify-character-claims.ts`, `npm run
  verify:character-claims`, 21/21 against local D1: claiming an alt of a
  standalone imported group claims the whole group and bootstraps the main
  pointer; a pre-seeded real identity's character refuses a silent
  transfer; two different requesters claiming siblings in one group — the
  approved one gets the whole group, the other's claim is denied, never
  granted anything; the same requester's duplicate claims on a group
  consolidate as approved; a genuinely standalone single-character claim
  with no group still works unchanged. No migration — reuses existing
  `players`/`characters`/`character_claims` columns. `tsc`, `npm run build`
  [webpack], and `verify`/`verify:guild-removal`/
  `verify:standings-resilience`/`verify:bid-finalization` all pass
  unchanged.)

**Not yet deployed** — no migration, so this can ship with any later phase's
deploy rather than needing its own. **Not browser-verified** — same
Discord-OAuth-credential gap as every prior claim/account-page change in
this plan; verified instead via the script above exercising the real
`assignCharacterToUser`/`attachCharacterToPlayer`/
`resolveOtherPendingClaimsForGroup` entry points end to end against local
D1.

## Phase 6: Mobile Foundation and Responsive Data Views

- [x] 6.1 Change the authenticated shell to mobile column/desktop row layout.
  (`AppShell.tsx` — the outer shell div was `flex` [row] unconditionally, even
  on mobile, so Sidebar's mobile-only top bar rendered as a row sibling
  squeezed next to `<main>` instead of stacking above it. Now `flex flex-col
  sm:flex-row`.)
- [x] 6.2 Make the mobile navigation a full-width accessible overlay/drawer
  with backdrop, focus management, Escape handling, and focus restoration.
  (`Sidebar.tsx`'s `MobileNavDrawer` — rebuilt the old inline collapsing
  `<div>` dropdown as a real `<dialog>` opened via `showModal()`, the same
  choice `ui/ConfirmDialog.tsx` already made: focus trap, `Esc`-closes
  [native `cancel` event], backdrop click-to-close, and focus restoration to
  the toggle button are all the browser's own spec-compliant implementation,
  not hand-rolled. `autoFocus` on the close button lands focus inside on
  open. Covered by `e2e/nav-drawer.spec.ts`.)
- [x] 6.3 Reduce mobile padding, enforce practical touch targets, and use at
  least 16px form text on phones. (`<main>` padding `px-6 py-8` →
  `px-4 py-5 sm:px-6 sm:py-8`. `ui/Field.tsx`'s `fieldClasses()` — the single
  shared helper nearly every form input in the app already goes through —
  now sets `text-base sm:text-sm` instead of a flat `text-sm`, since every
  field sits inside an ambient `text-sm` container and a bare `text-sm`
  input triggers iOS Safari's zoom-on-focus on any phone; also refactored
  the 3 remaining inputs that had duplicated `fieldClasses`' exact
  border/bg/focus CSS by hand [`ClaimThisCharacterButton`,
  `ClaimReviewButtons`] instead of using it, onto the shared helper, so the
  fix reaches them too. `ui/Button.tsx`'s `sm`/`md`/`lg` sizes gained a
  `min-h-9`/`min-h-11 sm:min-h-0` floor. Sidebar's mobile hamburger/close
  buttons and `AccountBlock`'s mobile variant are sized to a 44px target.)
- [x] 6.4 Add shared responsive page, tabs, filter, status, and data-view
  primitives only where repeated use justifies them. New `ui/MobileCard.tsx`
  — an expandable-card primitive used by both RosterTable and LedgerTable
  (task 6.5) — is the one new shared primitive this phase's actual repeated
  need justified. Did not extract a dedicated Tabs/FilterBar/StatusBadge
  component: existing per-page tab bars and filter rows weren't duplicated
  enough across pages to justify pulling out a shared abstraction over them
  — "only where repeated use justifies it" cuts the other way here.
- [x] 6.5 Give core tables compact expandable mobile rows instead of relying
  only on horizontal scrolling. **Applied to RosterTable and the EP/GP
  LedgerTable** — the two highest-traffic tables (Roster is named
  throughout this plan as the account-management directory; the EPGP Ledger
  is the other page every officer/leader change in this plan's history
  touches). Below `sm`, both render `ui/MobileCard.tsx` cards (key stats
  always visible, secondary columns behind an expand toggle; LedgerTable's
  edit mode becomes a stacked mini-form instead of table cells) instead of
  the `<table>`, which stays the `sm:`+ rendering — both markups are always
  in the DOM, swapped by CSS breakpoint, not a JS media query, so there's no
  hydration mismatch. **Not applied** to `TotalsTable`, `BidHistoryTable`,
  `AuditLogTable`, `RaidLootTable`, `BankBrowseTable`,
  `AdminCharacterList`/`MembersRolesList`'s own list, or `ClaimCharacterList`
  — deliberately scoped down to the two tables named above rather than
  attempting every table in the app in one pass; these still rely on
  horizontal scroll on a phone. Revisit if a later phase's mobile pass on
  Admin/Bank/Raids specifically calls for it.
  A real bug surfaced building this: `MobileCard`'s first version wrapped
  its whole summary in one `<button>`, and both callers' summaries carried
  their own interactive content [RosterTable's alt-toggle button, a
  character-name `<Link>`] — a real invalid-HTML nested-button/nested-link
  case, caught by React's own hydration-mismatch warning under Playwright,
  not by `tsc`/`build`. Fixed by giving `MobileCard` a dedicated small
  disclosure button beside the summary instead of wrapping the summary in
  one.
- [x] 6.6 Validate Dashboard, Roster, Account/Claims, Live Bids, Ledger, and
  Admin at 320, 375, 390, and 768px widths. Done via an automated Playwright
  sweep (`e2e/page-overflow.spec.ts`) against a real running local server
  with real local D1 data — not manual browser click-through, since no
  environment running this session has Chrome's Claude extension connected
  (a different, one-off gap from this plan's usual "no Discord OAuth"
  note — this was a missing browser connection, not a missing credential).
  The sweep found and fixed three real pre-existing overflow bugs, none of
  them touched by this phase's other tasks until this validation step
  surfaced them:
  - `epgp/ledger`'s tab bar (Totals/EP/GP/Bids/Audit) didn't wrap — added
    `flex-wrap`.
  - Dashboard's `VerticalBarChart` (the "Active Members by Class" bars and
    the Roster-by-Class chart) — each column `div` was `flex-1` but flex
    items default to `min-width: auto` [their own content's min-content
    size], so 16 class columns' text content refused to shrink below their
    natural width and overflowed instead. Added `min-w-0` down the whole
    flex chain plus a `truncate` on the label.
  - `RosterOverview`'s sticky filter bar used a fixed `-mx-6`/`px-6` bleed
    matched to `<main>`'s OLD flat `px-6` padding — task 6.3's
    `px-4 py-5 sm:px-6 sm:py-8` change broke that assumption on phones
    [only 16px of padding to bleed into, not the 24px the bleed math
    assumed]. Fixed to `-mx-4 px-4 sm:-mx-6 sm:px-6`, matching `<main>`'s
    padding at every width instead of just one.
- [x] 6.7 Add viewport, overflow, navigation, dialog, keyboard, and reduced
  motion tests. **This repo's first browser test suite** — everything
  before this was `scripts/verify-*.ts` against local D1 directly, or
  manual browser click-through; neither covers real rendered-DOM/CSS
  behavior like a nav drawer's focus trap. Added Playwright
  (`@playwright/test`, `playwright.config.ts`, `e2e/*.spec.ts`, 57 tests):
  `viewport.spec.ts` (unauthenticated `/login`, no session needed);
  `nav-drawer.spec.ts` (dialog open/close, focus landing + restoration,
  Tab-stays-inside, Escape, `prefers-reduced-motion` doesn't block the
  interaction — there's no CSS motion on this drawer to disable yet, so
  this is a baseline guard for when a later phase, e.g. Phase 9's landing
  page, adds real motion); `mobile-cards.spec.ts` (table↔card breakpoint
  swap, keyboard-operated expand/collapse); `page-overflow.spec.ts` (task
  6.6's sweep). New `scripts/e2e-auth-setup.ts` mints a real, valid
  better-auth session cookie against local D1 — via `better-auth/crypto`'s
  public `makeSignature` plus the app's own already-constructed auth
  instance's `$context`, not a deep import into better-auth's unexported
  internals — so the suite can drive the authenticated shell without
  Discord OAuth, which no environment running this suite has ever had; a
  synthetic `e2e-test-user` (role `leader`) is upserted fresh each run
  rather than depending on whatever's seeded locally. `npm run test:e2e`
  (setup + `playwright test`); config runs serially (`workers: 1`) against
  `next dev` [needed for local D1 bindings via
  `initOpenNextCloudflareForDev()`] after several workers cold-hitting
  different routes at once was observed to make `next dev`'s on-demand
  compiler abort in-flight requests — a test-infra flake, not an app bug.
  `e2e/.auth/` (the minted session + a resolved test character id) is
  gitignored.

## Phase 7: Bid-History Priority Clarity

The stored snapshot is calculated when a round is recorded, not necessarily at
the raw tell timestamp. Labels must not overstate historical precision.

- [x] 7.1 Rename the existing display column to `Recorded PR` and explain it
  with concise help text. (`BidHistoryTable.tsx` — the header is now
  "Recorded PR" with a `title` tooltip explaining it's captured when the
  round was recorded, not necessarily at the raw tell's own timestamp.
  `ui/table-sort.tsx`'s `SortableTh` gained an optional `title` prop for
  this — a small, backward-compatible extension of the one column-header
  component every sortable table already shares, not a new primitive.)
- [x] 7.2 Add `Current PR` from the current materialized player standing.
  (New column, read via `getStandingsForPlayers` against
  `player_epgp_totals` — the same targeted, never-10s-cached read Phase 4
  built for exactly this "one mutation's/one row's own player" case.)
- [x] 7.3 Store nullable player identity on new bid rows if needed for durable
  comparisons after character reassignment; backfill what can be inferred and
  update account-absorption logic. (Migration `0038_strong_tyger_tiger.sql`
  — plain `ADD COLUMN` + index, no table rebuild, applied `--local`; its own
  trailing `UPDATE` backfills every existing row from
  `characters.player_id` — the best inference available, since true
  historical ownership at bid time isn't reconstructable once a character's
  changed hands. `bid-finalization.ts`'s `finalizeBidRound` now captures
  `character.playerId` into every new bid row at write time, same as
  `gpLedger` already does. `players.ts`'s `absorbStandalonePlayer` now
  moves `bids.playerId` alongside `ep_ledger`/`gp_ledger`'s own player_id
  moves, so a bid recorded on a since-absorbed standalone player keeps
  tracking the SAME real person after their account merges into a real
  claim, not a stale/deleted player id.)
- [x] 7.4 Render both values as a compact stacked Priority field on mobile.
  (`BidHistoryTable.tsx` — desktop keeps two separate sortable "Recorded
  PR"/"Current PR" columns [`hidden sm:table-cell`]; below `sm` those
  collapse into one combined "Priority" cell showing both stacked
  [`sm:hidden`] — this table keeps its Phase 6 horizontal-scroll layout
  rather than a full MobileCard rebuild, which Phase 6 deliberately
  deferred for it; task 7.4's own "compact stacked field" ask is narrower
  than that and doesn't need it.)
- [x] 7.5 Add sorting and tests for null, reassigned, absorbed, and historical
  rows. Sorting: `useTableSort` gained `recordedPriority`/`currentPriority`
  keys (was one `priority` key on the old single column). Tests: new
  `scripts/verify-bid-history-priority.ts` (`npm run
  verify:bid-history-priority`), 21/21 against local D1 (snapshot/restore) —
  exercises the REAL `finalizeBidRound`/`attachCharacterToPlayer`/
  `listBidHistory` entry points, not just the display logic: a historical
  bid whose Recorded PR stays frozen while its player's later EP grant
  moves Current PR; a bid on a still-unclaimed character (`playerId` and
  Current PR both null, not a wrong guess); a bid's `player_id` correctly
  following a real account absorption (the defunct standalone player row
  gets deleted, Current PR still resolves post-absorption once standings
  catch up — same eventual-consistency contract Phase 4's dirty-marker
  design already established, not a new synchronous guarantee); and the
  migration's own backfill statement re-exercised directly against a
  simulated pre-Phase-7 NULL row.
  Verified: `tsc`, `npm run build`, `wrangler deploy --dry-run` (2723.99
  KiB gzipped, unchanged), the full Playwright suite (57/57, including the
  Ledger Bids tab's overflow checks at all four widths — confirms the new
  mobile combined column doesn't regress it), and `npm run
  verify`/`verify:bid-finalization`/`verify:character-claims`/
  `verify:standings-resilience`/`verify:guild-removal` all pass unchanged
  (`npm run verify` stays at its documented 9/13 baseline — unrelated code
  path).

**Deployed 2026-09-13** — the user applied migration 0038 to remote D1
themselves (`! npx wrangler d1 migrations apply seekers-of-souls --remote`;
this session's auto-mode has no access to that or to `npm run deploy`). The
first attempt 403'd with the same stale-OAuth-token symptom Phase 3 hit
(`wrangler whoami` showed a live-looking token with `d1 (write)` scope on
the right account, but the API call itself failed) — `wrangler logout` +
`wrangler login` (fresh browser OAuth) fixed it, then the retry succeeded:
368/368 `bids` rows backfilled with a `player_id` (`COUNT(*) = COUNT
(player_id) = 368`), no orphans. `npm run deploy` followed — Worker version
`9b959082-da00-4cd4-80d4-bca7295ca592`, bundle 2738.19 KiB gzipped (comfortably
under the 3072 KiB Free-plan cap), `buildId` = commit `645c4de` (confirmed
via `/api/health`). Read-only post-deploy checks: `/`, `/login` 200;
`/roster`, `/epgp/ledger`, `/admin` 307 unauthenticated; `POST
/api/officer/bids` with no key 401 — no regression. This also carries
Phase 6's mobile work live for the first time (it had no migration of its
own and was riding along with whatever deployed next). No parser change
needed — this phase is tracker-only.

## Phase 8: Roster and Admin Workflow Consolidation

- [x] 8.1 Make Roster the primary player/character directory with a clear
  `View / manage account` action for authorized roles. (`Phase 8.1` — Roster
  now shows an explicit account-management action for officer/leader/admin
  viewers on desktop and in expanded mobile cards; every member retains the
  existing read-only character/account link. Covered by the authenticated
  Playwright roster-card flow.)
- [x] 8.2 Keep role, linking, main-swap, removal, and reinstatement mutations on
  the Account page with existing server-side authorization. (`Phase 8.2` —
  removed Admin's duplicate established-member controls; the Account page's
  existing server actions remain the only UI mutation surface and retain their
  own authorization checks.)
- [x] 8.3 Surface pending-claim and setup indicators on relevant roster/account
  rows. (`Phase 8.3` — generic pending-claim badges now mark the relevant
  Roster and Account character rows, with an Account-level count and officer
  link to the claim queue; requester identity remains in the officer queue.
  The no-character setup state is the dedicated Admin queue from 8.5.)
- [x] 8.4 Remove the duplicate established-members list from Admin. (`Phase
  8.4` — Admin now leaves established accounts to Roster → Account, rather
  than duplicating their role/removal controls.)
- [x] 8.5 Retain a dedicated queue for verified Discord users with no character,
  since they cannot naturally appear in the roster. (`Phase 8.5` — retained
  and renamed Admin's `Account setup queue`; its only mutation assigns an
  unclaimed character to establish the account, after which management moves
  to Roster → Account.)
- [x] 8.6 Reorganize Admin into Needs Attention, Operations, EPGP, and System
  Health sections. (`Phase 8.6` — replaced the flat utility strip with
  role-filtered section cards; Needs Attention contains claim requests plus
  the setup queue, while Import Audit Trail anchors System Health.)
- [x] 8.7 Keep claim deep links/queue during the transition and verify every
  role's visible fields and allowed actions. (`Phase 8.7` — `/admin/claims`
  remains the queue/deep-link target. New authenticated Playwright coverage
  provisions local member/officer/leader/admin sessions plus an account and
  pending-claim fixture: member is read-only, officer gets roster/account and
  claim-queue actions, leader/admin get leadership controls. Full suite 61/61.)

## Phase 9: Public Landing Page and Login Flow

- [x] 9.1 Replace the generic feature-grid composition with a Norrath editorial
  layout using authentic guild/game imagery and guild-specific copy. (`Phase
  9.1-9.4` — asymmetric editorial hero built around the guild's existing
  recruitment artwork, optimized from a 2.1 MB PNG to a 224 KB WebP.)
- [x] 9.2 Establish an intentional public gold/brass/olive palette and display
  typography while retaining legible application typography. (Scoped to the
  public page; the authenticated application's semantic theme is unchanged.)
- [x] 9.3 Keep content focused on guild identity, raid facts, progression,
  recruitment, and the distinctive Quest Board. (The Quest Board is the
  central parchment treatment rather than another interchangeable feature
  card.)
- [x] 9.4 Add restrained CSS-first atmospheric motion with reduced-motion
  support; avoid heavy canvas, autoplay video, and interaction-blocking effects.
  (Decorative halo/poster movement only; no JavaScript animation.)
- [x] 9.5 Extract a reusable Discord sign-in control and put it directly on the
  landing page. (`Phase 9.5-9.6` — `DiscordSignInButton` is shared by the
  landing header and `/login`; recruitment Discord invite links remain
  distinct from member authentication.)
- [x] 9.6 Keep `/login` as fallback and later preserve a sanitized internal
  destination instead of always returning to `/characters`. (Protected page
  requests carry their path to `/login?next=...`; only same-origin absolute
  paths survive `sanitizeSignInDestination`, with `/characters` as fallback.)
- [x] 9.7 Measure responsive layout, image payload/LCP, keyboard navigation,
  contrast, and reduced-motion behavior before deployment. (`Phase 9.7` —
  Playwright covers 320/375/390/768/1440px without overflow, optimized hero
  payload under 300 KB and local LCP at or below 2.5s, keyboard skip/header
  focus order, representative WCAG AA color pairs, and reduced-motion CSS.
  Full browser suite 75/75; webpack and OpenNext production builds pass;
  Wrangler dry run is 2789.09 KiB gzip.)

## Phase 10: Recovery and Operational Hardening

- [x] 10.1 Do not expose direct D1 Time Travel restore from the main app.
  (`Phase 10.6` verifies `/admin/health` is read-only and contains no restore
  action; destructive recovery remains only in the operator CLI script.)
- [x] 10.2 Make raid and decay reversal transactional or explicitly resumable.
  (`Phase 10.2` — both reversals now use one
  set-based D1 batch for audit snapshots, the global dirty marker, deletes,
  and decay reversal metadata; local failure injection proves rollback.)
- [x] 10.3 Make the bookmark script capture and record a pre-restore bookmark
  automatically before executing any restore. (`Phase 10.3` — after typed
  confirmation, restore records the current bookmark in the canonical R2
  registry and fails closed if that upload does not succeed.)
- [x] 10.4 Verify and fix the standalone backup Worker's D1 export response
  parsing against the current Cloudflare API. (`Phase 10.4` — parses the
  documented nested completion result, validates API/operation failures,
  polls with `output_format`, uses unique keys, and paginates retention.)
- [x] 10.5 Decide and document a portable R2 backup cadence after verifying the
  actual Cloudflare plan and retention window. (`Phase 10.5` — a 10-day-old
  bookmark confirms Paid/30-day Time Travel; production D1 is 10.8 MB. Chosen
  policy is daily 09:00 UTC with 35 R2 copies. The scoped token and schedule
  are deployed; the first scheduled export restored successfully into
  disposable remote D1 with zero foreign-key violations.)
- [x] 10.6 Add a read-only System Health/Maintenance view for last rebuild,
  dirty standings, backup status, retention, and named restore-point metadata.
  (`Phase 10.6` — officer-visible `/admin/health`; leaders retain the separate
  settings-page rebuild control.)
- [x] 10.7 Keep restore-point metadata outside the D1 database it protects.
  (Canonical registry is R2 key
  `seekers-of-souls-imports/system-health/restore-points.tsv`; the existing
  local log has been uploaded and remains only an operator cache.)
- [x] 10.8 Exercise the operator recovery runbook without restoring production.
  (`Phase 10.8` — committed runbook plus `verify:recovery`; the drill covers
  atomic reversal/rollback, fake restore ordering, API fixtures, local health,
  and export→prepared SQL→fresh isolated D1 import. The first scheduled R2
  export was also restored into disposable remote D1 and validated without
  restoring production.)

## Phase 11: Better Auth 1.7.4 and Issuer Cleanup

This is deliberately separate from the emergency 1.7.2 async-context fix.
Better Auth 1.7.3 removed the temporary required `accounts.issuer` model, while
this database already carries a non-null issuer column and compound index.

- [x] 11.1 Review Better Auth 1.7.2 through 1.7.4 release and upgrade notes.
  (`Phase 11.1` — upstream 1.7.3 restores the stable 1.6 account identity key
  `(providerId, accountId)`, removes `issuer` from new writes, and explicitly
  requires SQLite to drop the issuer index before its column. It also enables
  initialization-time schema validation in production, so the checked-in
  Drizzle schema must match before auth traffic is accepted. The new strongly
  typed account APIs require a local account-row ID or signed account cookie;
  this app's sole `getAccessToken` caller already passes `accounts.id`, and it
  has no custom provider, account selector, or issuer-dependent application
  code. 1.7.4 adds instrumentation controls and Drizzle validation fixes but no
  further core schema change. All runtime packages and the transitive
  `@better-auth/core` override must move together; `nodejs_compat` and the
  1.7.2 Cloudflare async-context export-order fix remain required.)
- [x] 11.2 Generate and hand-review the SQLite/Drizzle migration that drops the
  issuer index and column in the required order. (`Phase 11.2` — removed the
  obsolete field/index from `auth-schema.ts`; Drizzle generated migration
  `0039_blushing_leper_queen.sql` as exactly `DROP INDEX` then `ALTER TABLE ...
  DROP COLUMN`, with no account-table rebuild. Before applying it, the local
  `(provider_id, account_id)` duplicate check returned zero and a named local
  snapshot was taken. The migration applied cleanly; aggregate verification
  preserved the existing account/access token, 46 sessions, and API key, while
  retaining `accounts_user_id_idx`, the primary key, and user foreign key.)
- [x] 11.3 Align every runtime Better Auth package on 1.7.4. (`Phase 11.3` —
  exact-pinned `better-auth`, `@better-auth/api-key`, and
  `@better-auth/drizzle-adapter`, plus the transitive `@better-auth/core`
  override, all resolve to 1.7.4. `better-auth-cloudflare@0.3.1` resolves
  against the same runtime versions. The legacy schema CLI remains a dev-only
  package and was not used to generate task 11.2's migration. TypeScript and
  the webpack production build pass with the existing local auth/base-URL,
  internal Durable Object, and middleware warnings.)
- [x] 11.4 Verify existing Discord login, first-time login, account linking,
  cookie cache, API keys, logout, and auth schema validation locally. (`Phase
  11.4` — new `npm run verify:auth-upgrade` passes 20/20 against local D1
  through Better Auth 1.7.4's real adapter and request handler. It initializes
  auth and exercises the enabled schema check; creates a first-time OAuth
  user/account; resolves the returning Discord identity by
  `(providerId, accountId)`; links a second provider; reads a signed session;
  proves the signed cookie cache still resolves after the session row is
  removed; runs API-key create/verify/list/delete/post-delete denial; and
  verifies logout deletes its session and clears the cookie. Synthetic users,
  players, accounts, sessions, and keys are removed in `finally`; local checks
  found zero leftovers. TypeScript and Playwright 81/81 pass. Local Discord
  credentials remain unavailable, so the test deliberately exercises the
  actual Better Auth OAuth persistence path without contacting Discord.)
- [x] 11.5 Apply the remote migration before code, deploy independently, and
  monitor authentication traffic. (`Phase 11.5` — the first scheduled portable
  backup was restored into scratch D1 and named Time Travel bookmark
  `pre-phase11-better-auth-1.7.4` was recorded before cutover. Remote duplicate
  check found zero `(provider_id, account_id)` conflicts. Migration 0039 then
  applied before code and preserved 27 accounts/access tokens, 77 sessions,
  and 11 API keys while removing only `issuer` and its index. Better Auth 1.7.4
  deployed independently as Worker version
  `2d0be9d1-7ae9-488d-805d-f9745f93e3ac` (health build `d398016`, 2,836.01 KiB
  gzip). Production auth initialization, unauthenticated session lookup,
  canonical Discord authorization URL/state cookie, protected-route redirect,
  canonical-host redirect, and missing-key denial all respond correctly; no
  migrations or foreign-key violations remain. The generated bundle still
  imports Workerd's real `AsyncLocalStorage` from `node:async_hooks`. A real
  signed-in Discord callback and existing officer-key success require member
  credentials and remain for ordinary live-user observation; production auth
  was not bypassed.)

## Production Verification Checklist

Apply the relevant subset after every deployed phase.

- [x] Record Git commit(s), branch, Worker version, migration(s), and parser tag.
- [x] Confirm unauthenticated routes and canonical redirects.
- [ ] Confirm authenticated navigation and session continuity.
- [ ] Confirm member/officer/leader/admin authorization boundaries.
- [ ] Confirm officer API-key success and revoked/demoted denial.
- [ ] Confirm no new `[hang]`, D1 watchdog, body-stall, or uncaught exception
  events under representative traffic.
- [x] Confirm authoritative ledger rows and derived standings agree after writes.
- [ ] Confirm live-bid reconnect, persistence, resolve, and clear behavior.
- [ ] Confirm desktop and mobile smoke routes.
- [x] Update this plan and durable repository notes with the observed result.

## Expected Commit Discipline

Commit names should match the repository's existing concise style and explain
the reason in the body. Each checked task may be one commit, or tightly coupled
tasks may share a commit when splitting them would create an invalid build.
Never combine unrelated cleanup with a stability or data-integrity fix.

At the end of each phase, report:

- commit SHAs in each repository;
- tests and builds run, including failures or skipped checks;
- migrations, deployments, Worker versions, and parser releases;
- production observations;
- remaining risks and the next unchecked task.
