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
- [ ] 0.7 Run tracker typecheck/build/runtime smoke tests, deploy this phase by
  itself, and monitor Workers Logs before proceeding. Typecheck/build/local
  smoke tests are done (see `db77e4a`'s commit message) — deploying and
  watching Workers Logs is the one part of this phase still open. Deploys
  are blocked in this session — hand to the user (`! npm run deploy`).

**Exit gate:** no request-state export mismatch; account collection views do
not issue automatic account-page prefetch storms; canceled concurrent RSC
tests settle; production has sufficient clean authenticated traffic after the
deployment.

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
  No migration needed (no schema change) — `npm run deploy` only, then
  confirm `/access-denied` for a removed account and a stale officer key's
  403 in production. Deploys are blocked in this session — hand to the user.

## Phase 2: Incremental Desktop Log Capture

The current parser repeatedly loads the complete EQ log with `os.ReadFile`.
Announcement and live-bid pollers rescan it independently, and the live loop
parses the same content more than once. A nearly 1 GB officer log makes this a
confirmed production failure mode.

- [ ] 2.1 Build one append-only tailer with file identity, byte offset, partial
  line buffering, and truncation/replacement handling.
- [ ] 2.2 Parse each appended line once and fan events into announcement,
  attendance, and active bid-round state.
- [ ] 2.3 Preserve bounded startup lookback and the existing rule that active
  character logs do not switch during a live bid round.
- [ ] 2.4 Decouple HTTP delivery from file ingestion using a bounded,
  coalescing latest-snapshot queue, short request deadlines, and capped retry
  backoff. Mark a snapshot delivered only after success.
- [ ] 2.5 Surface current log size, last successful push, pending retry, and
  delivery errors without blocking local capture or UI updates.
- [ ] 2.6 Test partial lines, same-second tells, repeated text, cancellations,
  truncation, replacement, character swaps, parked rounds, stalled HTTP, and
  recovery.
- [ ] 2.7 Generate a temporary large-log fixture and prove append latency is
  based on new bytes rather than total file size.
- [ ] 2.8 Run Go tests/vet, real `App` serialization tests, frontend build,
  binding generation as needed, and full Wails build.
- [ ] 2.9 Release through the tagged Windows workflow after compatible server
  behavior is live, then verify updater delivery.

## Phase 3: Atomic and Idempotent Bid Finalization

Finalization currently inserts the loot event, bid chunks, winner pointer, GP
charges, and standings refresh in separate operations. A timeout can leave
partial authoritative data, while retries rely on an item/time heuristic.

- [ ] 3.1 Introduce a client-generated immutable round/submission ID and carry
  it through parser live messages and final submission.
- [ ] 3.2 Add the required unique schema constraint and preserve compatibility
  during tracker-first/parser-second rollout.
- [ ] 3.3 Resolve and validate every character, player, tier, winner, and GP
  amount before writing.
- [ ] 3.4 Commit loot, bids, winner relationship, and GP ledger rows in one D1
  transactional batch.
- [ ] 3.5 Make retries return the existing successful result for the same
  submission ID without applying GP again.
- [ ] 3.6 Retain item/time duplicate detection only as an officer warning for a
  distinct possible duplicate drop.
- [ ] 3.7 Keep all application-defined Durable Object calls out of Next Route
  Handlers; live resolve/clear remains in `custom-worker.ts`.
- [ ] 3.8 Cover mid-write failures, client retry, duplicate drops, multiple
  winners, invalid rows, and standings-refresh failure.

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
