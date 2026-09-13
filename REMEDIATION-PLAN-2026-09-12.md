# Seekers Stability, Reliability, and UX Remediation Plan

**Created:** 2026-09-12  
**Status:** Approved for implementation  
**Applies to:** `seekers-tracker` and `seekers-epgp-parser`

This is the active implementation plan for post-launch stability, bid
reliability, account claims, responsive UI, workflow, and public-site work.
Read `../PLAN.md` first. That original plan remains authoritative for guild
rules, EPGP behavior, schema history, and architectural constraints. This plan
defines the order of new work and does not override those domain rules.

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
- [ ] 2.9 Release through the tagged Windows workflow after compatible server
  behavior is live, then verify updater delivery. Blocked on Phase 0's
  tracker deploy (server-side compatibility isn't observed live yet) and
  is itself a publish action (git tag + GitHub Release) — hand to the user
  when the phase is otherwise ready.

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

- [ ] 4.1 Remove or bypass the module cache for strict-freshness paths.
- [ ] 4.2 Add targeted standing reads for one or several player IDs.
- [ ] 4.3 Return affected current standing rows from successful mutations where
  the initiating client can update immediately.
- [ ] 4.4 Add durable dirty-player/global markers in the same transaction as
  authoritative ledger mutations.
- [ ] 4.5 Clear dirty markers only after successful materialization and add a
  frequent lightweight repair pass. Retain the nightly full drift check.
- [ ] 4.6 Ensure identity/account mutations cannot forget to refresh or mark
  affected standings.
- [ ] 4.7 Verify attendance, bids, manual entries, ledger edits, settings,
  decay, account absorption, and main-swap fees.

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

- [ ] 5.1 Treat `players.userId` as account ownership source of truth while
  keeping `characters.ownerId` synchronized for existing authorization/UI.
- [ ] 5.2 Let a member select one unclaimed character but create one pending
  claim for its linked player account.
- [ ] 5.3 Show the complete main/alt/mule group in member and officer review UI.
- [ ] 5.4 On approval, assign the player account and synchronize ownership for
  every linked character atomically.
- [ ] 5.5 Resolve duplicate pending claims across the complete group without
  deleting claim history.
- [ ] 5.6 Refuse silent transfers where the account or a linked character is
  attached to another real user/Discord identity.
- [ ] 5.7 Consolidate existing duplicate pending requests safely.
- [ ] 5.8 Cover standalone characters, imported groups, conflicting ownership,
  concurrent approvals, denial, and historical single-character claims.

## Phase 6: Mobile Foundation and Responsive Data Views

- [ ] 6.1 Change the authenticated shell to mobile column/desktop row layout.
- [ ] 6.2 Make the mobile navigation a full-width accessible overlay/drawer
  with backdrop, focus management, Escape handling, and focus restoration.
- [ ] 6.3 Reduce mobile padding, enforce practical touch targets, and use at
  least 16px form text on phones.
- [ ] 6.4 Add shared responsive page, tabs, filter, status, and data-view
  primitives only where repeated use justifies them.
- [ ] 6.5 Give core tables compact expandable mobile rows instead of relying
  only on horizontal scrolling.
- [ ] 6.6 Validate Dashboard, Roster, Account/Claims, Live Bids, Ledger, and
  Admin at 320, 375, 390, and 768px widths.
- [ ] 6.7 Add viewport, overflow, navigation, dialog, keyboard, and reduced
  motion tests.

## Phase 7: Bid-History Priority Clarity

The stored snapshot is calculated when a round is recorded, not necessarily at
the raw tell timestamp. Labels must not overstate historical precision.

- [ ] 7.1 Rename the existing display column to `Recorded PR` and explain it
  with concise help text.
- [ ] 7.2 Add `Current PR` from the current materialized player standing.
- [ ] 7.3 Store nullable player identity on new bid rows if needed for durable
  comparisons after character reassignment; backfill what can be inferred and
  update account-absorption logic.
- [ ] 7.4 Render both values as a compact stacked Priority field on mobile.
- [ ] 7.5 Add sorting and tests for null, reassigned, absorbed, and historical
  rows.

## Phase 8: Roster and Admin Workflow Consolidation

- [ ] 8.1 Make Roster the primary player/character directory with a clear
  `View / manage account` action for authorized roles.
- [ ] 8.2 Keep role, linking, main-swap, removal, and reinstatement mutations on
  the Account page with existing server-side authorization.
- [ ] 8.3 Surface pending-claim and setup indicators on relevant roster/account
  rows.
- [ ] 8.4 Remove the duplicate established-members list from Admin.
- [ ] 8.5 Retain a dedicated queue for verified Discord users with no character,
  since they cannot naturally appear in the roster.
- [ ] 8.6 Reorganize Admin into Needs Attention, Operations, EPGP, and System
  Health sections.
- [ ] 8.7 Keep claim deep links/queue during the transition and verify every
  role's visible fields and allowed actions.

## Phase 9: Public Landing Page and Login Flow

- [ ] 9.1 Replace the generic feature-grid composition with a Norrath editorial
  layout using authentic guild/game imagery and guild-specific copy.
- [ ] 9.2 Establish an intentional public gold/brass/olive palette and display
  typography while retaining legible application typography.
- [ ] 9.3 Keep content focused on guild identity, raid facts, progression,
  recruitment, and the distinctive Quest Board.
- [ ] 9.4 Add restrained CSS-first atmospheric motion with reduced-motion
  support; avoid heavy canvas, autoplay video, and interaction-blocking effects.
- [ ] 9.5 Extract a reusable Discord sign-in control and put it directly on the
  landing page.
- [ ] 9.6 Keep `/login` as fallback and later preserve a sanitized internal
  destination instead of always returning to `/characters`.
- [ ] 9.7 Measure responsive layout, image payload/LCP, keyboard navigation,
  contrast, and reduced-motion behavior before deployment.

## Phase 10: Recovery and Operational Hardening

- [ ] 10.1 Do not expose direct D1 Time Travel restore from the main app.
- [ ] 10.2 Make raid and decay reversal transactional or explicitly resumable.
- [ ] 10.3 Make the bookmark script capture and record a pre-restore bookmark
  automatically before executing any restore.
- [ ] 10.4 Verify and fix the standalone backup Worker's D1 export response
  parsing against the current Cloudflare API.
- [ ] 10.5 Decide and document a portable R2 backup cadence after verifying the
  actual Cloudflare plan and retention window.
- [ ] 10.6 Add a read-only System Health/Maintenance view for last rebuild,
  dirty standings, backup status, retention, and named restore-point metadata.
- [ ] 10.7 Keep restore-point metadata outside the D1 database it protects.
- [ ] 10.8 Exercise the operator recovery runbook without restoring production.

## Phase 11: Better Auth 1.7.4 and Issuer Cleanup

This is deliberately separate from the emergency 1.7.2 async-context fix.
Better Auth 1.7.3 removed the temporary required `accounts.issuer` model, while
this database already carries a non-null issuer column and compound index.

- [ ] 11.1 Review Better Auth 1.7.2 through 1.7.4 release and upgrade notes.
- [ ] 11.2 Generate and hand-review the SQLite/Drizzle migration that drops the
  issuer index and column in the required order.
- [ ] 11.3 Align every runtime Better Auth package on 1.7.4.
- [ ] 11.4 Verify existing Discord login, first-time login, account linking,
  cookie cache, API keys, logout, and auth schema validation locally.
- [ ] 11.5 Apply the remote migration before code, deploy independently, and
  monitor authentication traffic.

## Production Verification Checklist

Apply the relevant subset after every deployed phase.

- [ ] Record Git commit(s), branch, Worker version, migration(s), and parser tag.
- [ ] Confirm unauthenticated routes and canonical redirects.
- [ ] Confirm authenticated navigation and session continuity.
- [ ] Confirm member/officer/leader/admin authorization boundaries.
- [ ] Confirm officer API-key success and revoked/demoted denial.
- [ ] Confirm no new `[hang]`, D1 watchdog, body-stall, or uncaught exception
  events under representative traffic.
- [ ] Confirm authoritative ledger rows and derived standings agree after writes.
- [ ] Confirm live-bid reconnect, persistence, resolve, and clear behavior.
- [ ] Confirm desktop and mobile smoke routes.
- [ ] Update this plan and durable repository notes with the observed result.

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
