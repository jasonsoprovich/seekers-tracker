# Seekers of Souls — guild website + EPGP tooling

This is one repo of a three-repo system. Read this whole file before making
changes — it's the thing that survives a cleared conversation.

## ⚠ Read `../PLAN.md` first

**`../PLAN.md` (in the `seekers/` parent directory) is the authoritative
plan** for the current rebuild: verified findings about how the guild's EPGP
rules actually work, the target schema, and a phased task list with deadlines.

- **§11** is the execution plan — numbered phases, one task per commit, each
  tagged by repo.
- **§1–§10** explain *why*. Consult them when a task needs context.
- **Do not redesign anything covered there without saying so explicitly.**
  Several findings (decay is non-compounding; the EP cap was never
  consistently enforced; departure clears EP but never GP) are
  counter-intuitive and were verified against the live spreadsheet's formulas
  and cached values. Re-deriving them from intuition will get them wrong.

Work one phase at a time. Don't start a phase until the previous phase's
verification task passes.

**The three repos** (all siblings under `seekers/`):

| Repo | What it is |
|---|---|
| `seekers-tracker` (this repo) | The website: Next.js on Cloudflare Workers, D1, R2. Guild roster, character claiming, PoP flags, EPGP ledger/standings, admin panel. |
| `../seekers-epgp-parser` | Standalone desktop app (Wails: Go + React/TS) an officer runs locally. Parses their EverQuest log for raid attendance and loot bids, submits over HTTP. |
| `../seekers-bot` | Discord slash-command bot (Cloudflare Worker). **Not created yet — PLAN.md Phase 9.** |

**This repo owns the D1 schema and all migrations.** The other repos bind to
the database but never migrate it.

They talk over `/api/officer/*` routes authenticated with an officer-issued
API key (`x-api-key`) instead of a browser session — see "How the repos
connect". Repos get worked on in the same conversations; when you're deep in
one, check whether a change needs a matching change in another.

## Stack

- Next.js (App Router) deployed to Cloudflare Workers via OpenNext
  (`@opennextjs/cloudflare`)
- D1 (SQLite) via Drizzle ORM — `src/db/schema.ts` (app tables) +
  `src/db/auth-schema.ts` (better-auth's own tables)
- better-auth + Discord OAuth for site login; `@better-auth/api-key` plugin
  for officer API keys
- R2: `IMPORT_ARCHIVE` bucket (import audit trail), plus a separate
  `seekers-of-souls-db-backups` bucket used only by the standalone backup
  Worker (see below)
- Tailwind for styling

Custom domain: `seekers.fetchinglogic.com`. Worker name: `seekers-tracker`.

## Commands

```bash
npm run build                                          # typecheck + Next build
npm run deploy                                         # build + deploy to Cloudflare
npx drizzle-kit generate                                # generate a migration from schema.ts changes
npx wrangler d1 migrations apply seekers-of-souls --local   # apply locally
npx wrangler d1 migrations apply seekers-of-souls --remote  # apply to production — do this BEFORE deploying code that depends on it
npx tsc --noEmit -p tsconfig.json                       # typecheck only (fast)
```

`next lint` is currently broken in this repo (Next 16 / ESLint 9 config
issue, unrelated to any specific change) — don't chase it, it's a known
pre-existing gap, not something you broke.

**`build` uses `next build --webpack`, deliberately — do not "clean up" this
flag back to plain `next build`.** Found 2026-08-24: Next 16's Turbopack
disables nested chunking for server-side output (confirmed in Next's own
docs), which meant every new route added its own ~570 KB duplicate copy of
shared vendor code (Next's bundled `@opentelemetry/api`, mainly) into the
Worker script instead of sharing one. By the time Phase 11 shipped, the
compiled Worker was 3110 KiB gzipped — over the Workers **Free plan's 3 MiB
(3072 KiB) cap** — and bisecting past commits showed it had already crossed
that line during Phase 6, two days earlier; **no deploy had actually
succeeded since 2026-08-22**, despite Phases 5-11 all being marked shipped
here. Switching the production build to Webpack (still officially
supported — Next's own upgrade guide documents `next build --webpack` as
the way to keep Turbopack for `next dev` but not `next build`) properly
deduplicates that shared code: 2040 KiB gzipped, comfortably under the cap
again with real headroom for future phases. `next dev` is untouched (still
Turbopack, unaffected). Verified this isn't just smaller-but-broken: a real
local `wrangler dev --local` run against the webpack-built `.open-next/`
served `/`, `/login`, `/roster` correctly and redirected `/keys` to
`/login` when unauthenticated, no errors in the log.

## Local-first testing (PLAN.md §5) — important

**Develop and test against local D1, not remote.** `wrangler dev --local` and
`wrangler d1 execute --local` run against a real SQLite file via Miniflare:
**zero D1 billing, no row-read or write caps.** The free-tier budget problem
does not exist locally. **Never test decay or migration logic against remote
D1.** A bad decay run writes thousands of rows against the 100K/day write cap
and is painful to undo. Remote does have D1 Time Travel (7 days, free plan)
as a last-resort rollback — don't rely on it as a testing strategy.

- Local DB lives at
  `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite` (one real
  `.sqlite`, plus a `metadata.sqlite` to ignore).

**Seed from the sheet** — `scripts/import-epgp.ts` (run via
`npm run import:epgp -- --file "/path/to/SoS - EPGP.xlsx" --mode reset`).
Parses the guild's downloaded `.xlsx`, prints a reconciliation report
against the sheet's own cached `Totals` tab, and emits
`drizzle/seed/epgp-import.sql` (gitignored — regenerate, don't commit).
Apply with
`npx wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/epgp-import.sql`.
Deterministic and idempotent — safe to re-run after a fresh sheet export.

- **`--mode reset`** (default; `--wipe` is the old alias) clears the EPGP
  ledger/config tables first, then re-INSERTs every row (~140K writes with
  the player_id backfill; never touches `characters`, which is
  `INSERT OR IGNORE` either way). This is the production-snapshot tool
  (PLAN.md §14), and the one-time thing you run before the first sync.
- **`--mode sync`**: reconciles an already-seeded DB against a fresh export
  by emitting only the INSERT/UPDATE/DELETE for ledger rows that actually
  changed. The master sheet is read-only to us, so there's **no Key column**
  — `ep_ledger`/`gp_ledger.source_key` (migration 0025) is a **content hash
  the importer derives**: `sha1` of the row's identity (character name +
  date + activity for EP / + item for GP) plus a per-identity ordinal in
  sheet order. A value edit (points, note, tier, cycle) keeps the same key
  → `UPDATE`; a name/date/activity/item change, or an inserted/deleted row,
  → `DELETE` + `INSERT`. It reads the current keys+fingerprints back from
  the target (`wrangler d1 execute --json`; add `--remote` for production)
  and aborts if the target still has import rows with no `source_key` (run
  `--mode reset` there first). A typical weekly delta is a few hundred
  writes vs. ~140K; a do-nothing sync is ~35 idempotent config writes.

Both modes finish with a correlated `UPDATE` that fills ledger `player_id`
from `characters.player_id` (WHERE player_id IS NULL) — needed because
`computeEpgpTotals` groups strictly by ledger `player_id`. On a fresh
`--mode reset` that's a no-op until `derive:players --commit` has run, so
re-apply the emitted file's tail (or just those two UPDATEs) afterward. In
`--mode sync` the linkage already exists for everyone but brand-new
characters (re-run `derive:players` if the sync report lists any).

**Snapshot/restore** — `scripts/snapshot.sh {save|restore|list} [name]`
(`npm run snapshot -- save foo`) copies the live `.sqlite` to/from
`data/snapshots/` (gitignored — contains real guild member data). Instant,
no re-import. Use before any destructive test (a decay run, a migration
you're not sure about); restore to undo in one command.

**Verify** — `npm run verify` (`scripts/verify-harness.ts`) runs the actual
`computeEpgpTotals()` production code path against local D1 (via
`getPlatformProxy`, not a Workers dev server) and asserts EP/GP/decay/
priority for a curated set of characters (`scripts/golden-fixtures.ts`,
picked per PLAN.md §5 to exercise specific edge cases — floor-exempt,
cap-limited, GP-only-departed, all-3-expansion veterans) against the sheet's
own cached numbers. **This is the regression suite for every later phase —
run it after any change to `totals.ts`, a migration, or a re-seed, before
moving on.** A sheet re-export commonly drifts the local seed by a row or
two (officers keep editing the live sheet); if fixtures fail by small
amounts after a re-import, re-verify against a fresh sheet export before
assuming it's a code bug — `import-epgp.ts`'s own reconciliation report
(157/158 within ±1 as of 2026-08-21) is the independent check for that.
Exits non-zero on any failure, so it's CI-ready later.

`data/imports/` is **gitignored** — it holds Toryn's MySQL dump (Discord IDs
for every guild member) and in-game inventory exports. Never commit its
contents, and never print raw Discord IDs into logs or commit messages.

## Workflow conventions (do these without being asked)

- **Commit after every task in PLAN.md §11**, not just at the end of a
  session. Reference the phase/task: `Phase 0.3: repoint totals call sites`.
  Match the existing commit-message style — one-line summary, then a body
  explaining *why*, not just what. Never mention Claude in commit messages
  beyond the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
  trailer.
- **Migration order matters**: generate → apply `--local` → verify →
  apply `--remote` → *then* `npm run deploy`. Deploying code that expects
  a column/table before the remote migration exists will error in
  production.
- **After any change to `../seekers-epgp-parser`**: `wails generate module`
  (regenerates TS bindings), then `wails build`, from that repo's root —
  don't skip this even for a Go-only change if it touches an exported
  `App` method's signature.
- **Verify with real data, not just `go test`/`tsc`**: this project has
  been bitten twice by bugs that unit tests didn't catch — a JSON
  `null`-vs-`[]` crash and a bid-window logic bug — both only surfaced
  when actually running the real `App` methods against
  `internal/parse/testdata/*.txt` and inspecting the JSON output. When
  touching `app.go` or `internal/parse`, write a throwaway
  `app_manual_test.go` (package `main`) that calls the real methods and
  prints JSON, run it, then delete it before committing.
- **Run the EPGP verification harness (PLAN.md §5 / task 0.8) after any
  change touching points, decay, the cap, or totals.** It asserts computed
  EP/GP/decay/priority against the spreadsheet's own cached values. Drift is
  a bug, not acceptable rounding.
- If something looks broken in production, reach for `npx wrangler tail
  seekers-tracker --format pretty` before guessing — it's what found both
  the OAuth-callback bug and confirmed the fix, live.

## How the repos connect

- `src/lib/api-key-auth.ts` — `requireOfficerApiKey()`, called by every
  `/api/officer/*` route. Verifies the `x-api-key` header via
  `auth.api.verifyApiKey` directly (NOT better-auth's
  `enableSessionForAPIKeys`, which would mock a full site session for any
  valid key — scoped explicitly instead, per that file's comment).
- Officers generate their own key at `/epgp/app-key` (linked from both
  Roster and Admin).
- Routes the parser app calls:
  - `GET /api/officer/characters` — roster + resolved `mainCharacterName`
    + `priorityRating` per character (alt borrows its main's).
  - `POST /api/officer/characters` — creates a character the roster has
    never seen, from just a name (a captured Attendance/Bids row with no
    match): as a new alt of an existing main when `mainCharacterId` is
    given, or as a brand-new main when it's omitted. `class`/`race`/
    `level` are unknowable from a log capture, so it uses the same
    `UNKNOWN_CLASS_ID`/`UNKNOWN_RACE_ID`/level-1 placeholder convention
    `scripts/import-epgp.ts` uses for sheet-only characters. See the
    parser app's `NoMatchSelect.tsx`.
  - `GET /api/officer/items` — distinct `gp_ledger.item_name` values (item
    autocomplete; no separate items catalog).
  - `GET /api/officer/point-values` — non-retired EP/GP activities, for
    the app's Manual Entry tab.
  - `GET /api/officer/ledger` / `GET /api/officer/totals` — same
    paginated/search queries as `/epgp/ledger` and `/roster`, as JSON, for
    the app's Browse tab.
  - `POST /api/officer/manual-entry` — one EP/GP row (donations,
    milestones, ad-hoc adjustments).
  - `POST /api/officer/attendance` — bulk EP award from a `/who guild`
    capture; points resolved server-side from `epgp_point_values`, never
    trusted from the client.
  - `POST /api/officer/bids` — records a full bid round (`loot_events` +
    `bids` rows, won/lost) and charges GP to whichever entries are
    flagged `isWinner` (can be more than one, for a duplicate drop).
- **EP/GP is always attributed to a character's main**, never an alt —
  enforced once, centrally, in `insertLedgerEntry`
  (`src/lib/epgp/ledger-entry.ts`), which every write path (website form,
  officer routes) goes through. `computeEpgpTotals`
  (`src/lib/epgp/totals.ts`) groups strictly by raw `character_id` with no
  alt→main collapsing of its own — a row landing on an alt's own id would
  be invisible on Roster, which only ever displays a main's totals for its
  alts.
  **PLAN.md Phase 3 changes this**: attribution moves from the main
  *character* to a `players` account row, so a main swap no longer orphans
  history. Don't build new logic on the character-keyed assumption.
- `docs/guild-website-feasibility.md` §9 task 20 / §10 describes an
  earlier plan (Cloudflare Cron pulling the guild's Google Sheet). **That
  was superseded by the parser-app + API-key architecture described
  here** — the sheet-sync plan was never built. Don't treat that section
  of the doc as current. Where it conflicts with `../PLAN.md`, PLAN.md wins.

## Hard-won gotchas (don't rediscover these)

- **Never call an app-defined Durable Object from a Next.js Route Handler
  under OpenNext — route it through `custom-worker.ts` instead.** Found
  2026-08-30: the parser app's live-bid poll (`POST
  /api/officer/live-bids/{push,heartbeat}` every ~5s during a round) took
  `wrangler dev` / `npm run preview` down within ~15s every time —
  `Error: Network connection lost.` in `ProxyController.emitErrorEvent`,
  stack bottoming out in miniflare's `#handleLoopbackCustomFetchService`,
  process exits. Cause: a Route Handler runs inside OpenNext's Node
  loopback, so a DO call from there is a double hop (workerd → Node
  loopback → back to workerd for the DO RPC), and that loopback can't
  sustain the repeated round trips. Ruled out: wrangler 4.123→4.127.1
  (identical), `ctx.storage.setAlarm` debounce, stub-fetch try/catch —
  none helped; only removing the loopback hop did. **Fix shipped same day**
  (PLAN.md §15 multi-officer rework): `/api/live-bids/state` and
  `/api/officer/live-bids/{push,heartbeat,clear}` are now handled directly
  in `custom-worker.ts` (where the WS upgrade already was), so the DO RPC
  never leaves workerd. Verified: 3 simulated officers pushing different
  items every 2s for 2 min (129 requests) with the server staying up the
  whole time. `api-key-auth.ts` gained `verifyOfficerApiKey(request, env,
  cf)` for callers outside Next (it can't use `getCloudflareContext()`).
  **`POST /api/officer/bids` (a Next route) no longer touches the DO at
  all** (2026-08-31). It used to clear the finalized round as
  belt-and-suspenders — "one call per round, not a loop" was assumed safe
  — but with a WebSocket viewer connected it still tipped `wrangler dev`
  over the same way (surfaced while testing the Phase 15 live round view).
  The parser app now clears its own round on "End Round & Review" and on
  app-quit via `POST /api/officer/live-bids/clear` (served from
  `custom-worker.ts`), and the DO's 5-min idle sweep covers anything that
  slips through. **No app-defined DO call from any Next route handler,
  period** — if you need one, it goes in `custom-worker.ts`.
  `src/lib/live-bids/session.ts` (the old `getLiveAuctionSessionStub`
  helper) is deleted; `custom-worker.ts`'s `liveAuctionStub` is the only
  resolver now.

- **better-auth schema changes need their data backfilled, not just
  migrated.** Upgrading the `better-auth`/`@better-auth/*` version can add
  required columns (e.g. 1.7 added `accounts.issuer`, looked up as a
  compound `(issuer, accountId)` pair) that `drizzle-kit generate` will
  produce a migration for, but won't backfill existing rows — the
  generated SQL can even be syntactically broken (`ADD COLUMN ... NOT
  NULL` with no `DEFAULT` fails outright on a non-empty SQLite table).
  Read that version's upgrade guide for manual-preparation callouts before
  assuming `generate` + `apply` is sufficient. This exact gap broke Discord
  login in production once already (see commit `5ee052c`).
- **Go `time.Parse` defaults to UTC.** The EQ client log has no timezone
  of its own — its timestamps are the officer's local wall-clock time,
  same machine the app runs on. Use
  `time.ParseInLocation(layout, s, time.Local)`, not `time.Parse`, or
  timestamps silently shift by the machine's UTC offset when displayed
  back in the frontend.
- **Go nil slices serialize to JSON `null`, not `[]`.** A Wails-exposed
  struct with a `[]string` field that starts as `var x []string` (nil
  until appended to) will send `null` on the clean/common path where
  nothing gets appended. The frontend calling `.map()` on that crashes —
  `?.` on the parent object doesn't guard a null *field*. Initialize slice
  fields as `[]T{}`, not `var x []T`, on any struct that crosses the
  Go→JSON→JS boundary.
- **Wails bindings only carry one return value plus a trailing error.** A
  Go method like `func (a *App) Foo() (x, y Thing, err error)` gets
  silently truncated in the generated TS — `y` just vanishes from the
  binding, no build error. Wrap multi-value returns in a single struct
  (see `PointValues`/`LedgerPage` in `app.go`).
- **Bid-tier rank order**: High Bid (4) > Medium Bid (3) > Low Bid (2) >
  Alt Loot (1) for winner determination — Alt Loot ranks *below* Low Bid
  even though both cost 10 GP today, per the guild's own documented tier
  ordering (feasibility doc §10). Confirmed with the user, not assumed.
- **The 900 EP cap was never consistently enforced historically** — 189 of
  3,493 (cycle, character) pairs exceed it in the sheet. Import recorded
  awarded values as-is; never recompute them from nominal. PLAN.md §2.

## Roadmap / status (update this section as things ship or change)

**Leader-requested batch 4 (item 4d) — record a missed bid / missed
attendance, 2026-09-04 (tracker commit `2f7eb20`; parser commit `7392eee`;
parser needs a release).**
- **Tracker:** `POST /api/officer/bids` gained a soft duplicate guard —
  same item name + a winning-entry time within 12h of an existing
  `loot_events` row → `409 { error, duplicate }`, nothing written, unless
  the body carries `confirmDuplicate: true`. Stops a double-clicked
  finalize (or a manual re-entry) from silently doubling the winner's GP
  charge; a real second drop the same night is confirmed through.
  Case-insensitive on item name. Verified against local D1.
- **Parser:** Manual Entry tab has a mode selector — "EP / GP adjustment"
  (the old form), "Missed bid", "Missed attendance". Missed bid
  (`MissedBidForm`): item autocomplete + date/time + a per-bidder table
  (name/`NoMatchSelect`, tier, winner), posts via new `App.SubmitManualBid`
  → `officerapi.SubmitBidsChecked`, which surfaces the 409 as
  `BidsResponse.Duplicate` + message so the form offers "Record anyway"
  (resends `confirmDuplicate`). Missed attendance (`MissedAttendanceForm`):
  activity + date/time + optional zone + names one-per-line →
  `App.SubmitAttendance` (its `(player, activity, time)` dedupe already
  reports already-recorded names as "skipped"). `wails3 generate bindings`
  run; go + frontend builds clean; not GUI-verified.

**Leader-requested batch 4 (items 4a/4b) — parser panels survive tab
switches, 2026-09-04 (`../seekers-epgp-parser` commit `f1de44e`; ships with
the same release as item 1).** `App.tsx` rendered each panel as
`tab === "x" && <Panel />`, so a tab switch unmounted it and dropped its
React state — an officer lost an unsubmitted Attendance capture or an open
Bids round just by glancing at another tab. Now every panel stays mounted
(`hidden` attr on a wrapper div); no panel polls on a background interval,
so it's one extra startup fetch each and nothing ongoing. Attendance and
Bids each got a header **Clear** button that deliberately discards the
current capture/round (Bids also clears the site's live round + stale
banners); the Bids review "Discard" is relabelled "Clear". frontend
`tsc`+`vite build` clean; not GUI-verified (needs a Wails build).

**Leader-requested batch 4 (item 1) — parser attendance zone fix,
2026-09-04 (`../seekers-epgp-parser` commit `ed3a5a1`; NEEDS A RELEASE
BUILD — see below).** Two separate problems: (a) the zone was never
reaching the site at all because the officers' installed binary
(`bin/`, dated 2026-09-01) predates the original zone commit `be6fbc9`
(09-02); (b) even with that code, the zone came from the `/who` block's
"There are N players in <Zone>." footer, which for `/who guild` (what
officers use, to catch anonymous raiders) reads "…in EverQuest." not the
raid zone. Fixed (b): `ParseAttendance` now tracks the most recent real
"You have entered X." line and uses that, falling back to the footer only
when the capture has no zone-in; "You have entered an area where
levitation…" and friends are filtered. `cmd/simlog` emits a zone-in line
per `/who` round. No `App` signature change (`SubmitAttendance` already
carries `zone`), so no bindings regen. **To ship: cut a parser release**
— `git tag vX.Y.Z && git push --tags` on `../seekers-epgp-parser`
(`build-windows.yml` builds + publishes the GitHub Release; officers'
in-app updater picks it up). The tracker side (`ep_ledger.zone`, migration
0024, the Ledger Zone column) is already done and just needs the remote
rollout above.

**Leader-requested batch 3 (items 2/3) — live-bids resolved cards persist +
collapse, 2026-09-04 (LOCAL, no migration; needs a deploy + is NOT
browser/endpoint-verified — same standing gap as every live-bids change).**
- `LiveAuctionSession` DO: a resolved round no longer auto-expires
  (`expiryOf` → `Infinity`) and is no longer swept when the same officer
  starts their next item (`sweepResolvedForOfficer` and its `/push` call
  deleted; `RESOLVED_EXPIRY_MS` gone). It stays on the board until a member
  `/dismiss`es it or the officer app `/clear`s it on quit. Collecting
  rounds still idle-expire at `ROUND_EXPIRY_MS` (an abandoned collection
  nobody finalized).
- `LiveBidsView`: resolved cards render **collapsed** — winner line + a
  "▸ Show all N bids" toggle; collecting cards stay fully expanded (watching
  live is the point). Resolved cards stay inline + dimmed (no separate
  stack — leader's call). Added an on-mount `fetch('/api/live-bids/state')`
  alongside the WebSocket so navigating away and back repaints the open +
  resolved rounds immediately instead of showing a blank "Connecting…" gap.
  Bid "Prio" column now 4 dp; its header renamed "Tier" → "Bid" (matches
  batch 1).
- `tsc` + `build` clean.

**Leader-requested batch 3 (item 5) — Dashboard "Active Members by Class",
2026-09-04 (LOCAL, no migration).** `ActiveByClass.tsx` on `/dashboard`
(below the existing charts): OpenDKP-style board, one card per class listing
that class's characters with EP/GP ledger activity inside a
24h/7d/1mo(default)/1yr window, ranked by the player's Loot Priority (4 dp).
Mains and alts both shown; alts dimmed + "alt" tag. Empty classes hidden.
The window is a pure client-side filter — `dashboard/page.tsx` sends the
whole active roster once (`getStandings` gives per-player `lastActivityAt` +
`priorityRating`; mules and player-less characters excluded). `nowMs` is
passed from the server to avoid a hydration mismatch. Local data: 95 / 251 /
282 / 565 characters in the four windows.

**Leader-requested batch 3 (item 9) — "Remove from guild" now zeroes EP,
reversibly, 2026-09-04 (migration 0027, LOCAL ONLY).** Hard character
deletion is gone entirely (`deleteCharacter` action + `DeleteCharacterButton`
+ the delete button on `/admin`'s All Characters list) — the leader's call:
always keep a record and an audit trail. A bogus character row is now a
SQL-sandbox cleanup, not a routine button.
- `removeMemberFromGuild` (still leader-only, still the "Remove from guild"
  button in `/admin` → Members & Roles) now does three things, all reversed
  by `reinstateMember` except the role: (1) role → member, (2)
  `players.status` → `departed` (the existing access block), (3) **zeroes
  the player's EP across every one of their characters** via
  `commitDepartureWipe({ characterIds })` — a `decay_events` kind
  `departure` batch, GP untouched (§1e). The event id is stored on the new
  `players.removal_decay_event_id` (migration `0027`, plain nullable
  `ADD COLUMN`); `reinstateMember` calls `reverseDecayEvent` on it,
  restoring the EP, and nulls the column. Safe if the batch was already
  reversed by hand on `/epgp/decay` (matches `/already reversed|not found/`
  and proceeds). A player with 0 EP everywhere just gets no batch and a null
  pointer.
- `RemoveMemberButton` gained a confirm on Reinstate (it now restores EP,
  not just access) and both confirm messages + the `/admin` blurb say EP is
  zeroed/restored and GP is kept.
- Verified against local D1 (throwaway script, snapshot/restore): a real
  2-character player, raw EP 14902.4 → 0 on remove (GP 828.9 unchanged,
  materialized standings ep → 0, departure event written), → 14902.4 on
  reinstate (event reversed, standings restored). `tsc` + `build` clean,
  `npm run verify` 11/13 (unchanged seed noise).

**Leader-requested batch 1 — decay defaults, UI polish, 2026-09-04 (LOCAL
ONLY — the settings-row change needs applying to remote too, see the
standings rollout list below).** Small confirmed items, one commit:
- **Decay defaults flipped to the post-cutover rules.** `DEFAULT_SETTINGS`
  (`src/lib/epgp/settings.ts`) and `scripts/import-epgp.ts`'s seed block:
  `decay_model` legacy→**global**, `ep_decay`/`gp_decay` 0.2→**0.1**. Also
  written into local `epgp_settings` as effective-dated rows (effective_from
  = 2026-09-04, note explaining the cutover) — NOT effective_from=0, so
  `verify-harness` (pinned `FIXTURES_AS_OF` 2026-08-21) still resolves
  legacy/0.2 and stays 11/13. `import-epgp.ts` gained `SHEET_RECON` (legacy
  0.2 / base 150) for its Totals-tab reconciliation self-check, since
  `SETTINGS` no longer reproduces the sheet's numbers.
- **Expansion decay form default** 0.85→**0.90** (`ExpansionDecayForm`).
- **Cancel button** on all three decay preview forms (Expansion / Global
  cycle / Departure wipe) — clears the preview client-side, no server call.
- **Priority shows 4 dp** on the roster (`RosterTable`, was 2) to match the
  sheet's Loot Priority column. Decay-rate settings show 2 dp (0.10).
- **`SettingRow`** value + Change button now pin top-right regardless of
  description length (was wrapping to a left-aligned line for the long
  Base EP/GP blurbs). `ep_decay`/`gp_decay`/`decay_model` descriptions
  rewritten for the global default.
- **"Tier" → "Bid"** as a display label only (GP Ledger tab header, Bids
  History header, manual-entry field label, "… is required" errors,
  placeholder). The `gp_ledger.tier` column and its values are untouched —
  the DB rename is batch 2.
- **Gear tab removed** from `/characters/[id]/import` (`ImportTabs` +
  page wiring). `importGear` action and `ImportGearForm.tsx` left in the
  tree unreferenced, same as the still-present `/characters/[id]/gear`
  route (gear came out of the UI in 635df4e).
- Verified: `tsc` + `build` clean, `npm run verify` 11/13 (unchanged
  Takkisina/Kaalos seed noise), `recompute:standings` 255/0.

**Materialized EPGP standings — `player_epgp_totals`, 2026-09-04 (migration
0026, LOCAL ONLY so far — needs `--remote` apply + a deploy, and
`npm run recompute:standings` against remote right after, before the read
paths have anything to read).** Replaces the 45s Cloudflare edge cache over
`computeEpgpTotals` (PLAN.md §6 tasks 0.1-0.4). That function runs 4
unfiltered `GROUP BY SUM()` over the whole `ep_ledger`/`gp_ledger` (~46K
rows) — ~93K rows read per `/roster` render once its own two `max()` scans
are counted — and `/roster` + 3 officer routes + `custom-worker.ts`'s
live-bid priority lookups all called it per request. The cache traded a
stale-standings window and an invalidation race (the "roster didn't update
after attendance" report that kicked this off) for the row-read savings.
- `player_epgp_totals` (migration `0026_player_epgp_totals.sql`, plain
  single `CREATE TABLE`, no rebuild): one row per player — `ep/gp/ep_decay/
  gp_decay/priority_rating/raw_ep/raw_gp/pre_cycle_ep/pre_cycle_gp/
  last_activity_at/updated_at`. It's the exact output of `computeEpgpTotals`
  stored instead of recomputed.
- `src/lib/epgp/standings.ts`: `refreshStandings(db, { playerIds } | { all:
  true })` recomputes one/many players (index-seeked via a new
  `computeEpgpTotals({ playerIds })` filter) or everyone, upserts, prunes
  stale rows (chunked deletes — Miniflare D1 trips "too many SQL variables"
  well under 999). `getStandings(db)` reads the ~255-row table into the same
  `Map<playerId, …>` shape `getCachedEpgpTotals` returned, plus
  `lastActivityAt` folded in so `/roster` drops its own two ledger `max()`
  scans.
- Every write path that used to call `invalidateEpgpTotalsCache()` now calls
  `refreshStandings()` instead: `insertLedgerEntry` (single player;
  `deferStandingsRefresh` opt for bulk callers), `/api/officer/attendance`
  (one batched refresh for the whole `/who` capture), `updateLedgerEntry`/
  `deleteLedgerEntry` (the row's own player), `/epgp/settings` and all 3
  `decay.ts` commit/reverse paths (`{ all: true }` — those move everyone).
  `getCachedEpgpTotals`/`invalidateEpgpTotalsCache` and the Cache API
  plumbing are deleted from `totals.ts`; `computeEpgpTotals` stays as the
  reference impl (verify-harness) and the recompute source.
- No cron added: under `decay_model=global` (the intended default) the
  table only changes on a ledger/decay/settings write, all hooked. Under
  `legacy` the pre/current-cycle split shifts for everyone at each rollover
  — run `npm run recompute:standings` then (it's also the initial backfill
  and a drift check: asserts every materialized row matches a fresh
  `computeEpgpTotals` to the cent, exits non-zero otherwise).
- Verified local: `recompute:standings` 255 players / 0 mismatches; `npm run
  verify` 11/13 (the 2 "fails" are Takkisina/Kaalos with the known +50
  attendance-test seed noise, not a regression); `verify:global-decay` all
  pass (refreshStandings runs fine inside `commitRateDecay`); `tsc` + `npm
  run build` clean. **Not browser-verified** — same Discord-OAuth gap as
  every prior change. **Not yet applied to remote D1 / deployed.**
- **Remote rollout order (when the user asks for the Cloudflare update) —
  the post-deploy backfill is REQUIRED, not optional:**
  1. `npx wrangler d1 migrations list seekers-of-souls --remote` — see
     what's outstanding (likely 0024 zone + 0025 source_key + 0026
     standings + 0027 removal_decay_event, none applied to remote yet).
  2. `npx wrangler d1 migrations apply seekers-of-souls --remote` (applies
     them oldest-first). 0025 caveat: remote import rows then have NULL
     `source_key` until the next `--mode reset`; `--mode sync` refuses an
     unkeyed target.
  3. `npm run deploy` — check gzipped bundle stays under the 3072 KiB Free
     cap (`wrangler deploy --dry-run`).
  4. **Apply the batch-1 decay-defaults settings change to remote.** Local
     got three effective-dated `epgp_settings` rows (`decay_model=global`,
     `ep_decay=0.1`, `gp_decay=0.1`, effective 2026-09-04). Remote needs the
     same — either a leader sets each on `/epgp/settings` post-deploy (the
     intended path; writes history + refreshes standings), or apply the
     equivalent INSERTs via `wrangler d1 execute --remote`. Do this BEFORE
     step 5 so the backfill computes under the global model.
  5. **Backfill `player_epgp_totals` on remote.** Until this runs, every
     read path (`/roster`, `/api/officer/{bids,totals,characters}`,
     custom-worker's live-bid priority) sees an empty table and shows blank
     standings. `npm run recompute:standings` is `getPlatformProxy` /
     local-only as written — add a `--remote` path to it (drizzle over the
     remote D1 binding), or run `refreshStandings(db, { all: true })` once
     against remote another way. ~255 row writes, safe vs the 100K/day cap.
  6. Verify live: `/roster` shows numbers (priority at 4 dp; decay 0 under
     global); a test attendance/manual entry moves the roster within
     seconds (no 45s cache now); `wrangler tail` clean.

**Incremental sheet re-sync — `import-epgp.ts --mode sync`, 2026-09-03
(migration 0025, LOCAL ONLY so far — needs `--remote` apply before it's
usable against production).** Migration `0025_ledger_source_key.sql` adds a
nullable, uniquely-indexed `source_key` to `ep_ledger`/`gp_ledger` (plain
`ADD COLUMN` + `CREATE UNIQUE INDEX`, no table rebuild). `import-epgp.ts`
gains `--mode reset` (the old `--wipe`, now also writing `source_key`) and
`--mode sync`. **The master EPGP sheet is read-only to us — no Key column
can be added** — so `source_key` is a **content hash the importer derives
itself**: `sha1(identity)` where identity = character name + date +
activity (EP) / + item (GP), plus a per-identity ordinal in sheet order to
separate genuinely-repeated entries. Mutable fields (points/note/tier/
cycle) are deliberately out of the hash, so a value correction to an old
row keeps its key and syncs as an `UPDATE`, not a churn. `--mode sync`
reads the current keys + a content fingerprint back from the target
(`wrangler d1 execute --json`, `--remote` for production), diffs, and emits
only the INSERT/UPDATE/DELETE for what changed; it refuses to run if the
target still has import rows with no `source_key` (must `--mode reset`
there once first). Purpose: keep remote D1 in step with the live sheet
during the pre-cutover multi-officer testing window without ~140K row
writes per re-snapshot against D1's 100K/day cap (weekly delta ≈ a few
hundred writes; a no-op sync ≈ 35 idempotent config writes). Both modes now
also emit the ledger `player_id` backfill that was previously a manual
one-off. **Considered but rejected**: adding a Key column to the sheet
(can't touch the master); staying on `--mode reset` + upgrading to Workers
Paid (viable fallback — $5/mo makes the write volume a non-issue — but
keeps the mid-wipe data gap and ledger-id churn). Verified end-to-end
against local D1: `reset` seeds every row's `source_key`; an identical
frozen round-trip re-run syncs +0/~0/-0; an edit + add + delete + rename in
the sheet produces exactly `EP +2 ~1 -2` (rename = delete old key + insert
new; edit = UPDATE, id preserved) and re-syncs clean; the "seed first"
guard fires on an unkeyed DB. `npm run verify` 13/13, `tsc` clean.
**Not yet applied to remote D1** — see "Seed from the sheet" above for the
workflow.

**EP-table zone + resolved live-bid cards keep every bid, 2026-09-01
(migration 0024, LOCAL ONLY so far — needs `--remote` + a deploy + a
parser release).** Two leader-requested tweaks in one pass:
- **`ep_ledger.zone`** (migration `0024_ep_ledger_zone.sql` — a plain
  nullable `ADD COLUMN`, applied `--local` only). The parser already
  parsed the `/who` capture's zone (`AttendanceResult.Zone`) and showed it
  in-app but never sent it. Now `SubmitAttendance` takes a `zone` arg
  (Wails binding regenerated), `AttendanceRequest`/`POST
  /api/officer/attendance` carry `zone`, `insertLedgerEntry`'s `ep` variant
  writes it, and it's threaded through `listLedgerRows` →
  `EpLedgerRow.zone` → a new **Zone** column on the EP Ledger tab
  (`LedgerTable`, editable; `updateLedgerEntry` ep variant + a new optional
  Zone field on `AddLedgerEntryForm` for manual EP rows). NULL on manual/
  decay/imported/pre-column rows → shown as "—". Verified against local D1
  (throwaway `getPlatformProxy` script: insert an `ep_ledger` row with a
  zone, read it back through `listLedgerRows`, delete — PASS); `npm run
  verify` still 13/13; `npm run build` + `tsc` clean.
- **Resolved `/live-bids` cards keep the full bid list.** Before: the
  parser's `ResolveLiveBids` sent only the winner(s), so a dimmed "WON"
  card collapsed to winner-only (the DO's `round.bids` was whatever the
  live poller last left, often already swept). Now `ResolveLiveBids` sends
  the whole reviewed bid list (`ResolveLiveBidEntry[]`, each flagged
  `isWinner`) — `custom-worker.ts`'s `/resolve` handler resolves each
  name's current priority (one `getCachedEpgpTotals`, cached per name),
  dedupes one-row-per-character (winner row wins the slot, else latest —
  same as the collecting card and the parser's `ResolveLatestPerCharacter`),
  derives `winners` from the `isWinner` flags, and forwards both `bids` and
  `winners` to the DO. The DO's `/resolve` sets `round.bids` from the
  incoming list when non-empty (older parser sending no `bids` keeps its
  last live-collected set). `LiveBidsView.tsx` needed **no change** — it
  already renders `round.bids` with a Prio column and winner highlighting
  for resolved rounds. Card lifetime is unchanged (swept on the officer's
  next item / ~20 min / member Dismiss). **Not browser-verified** — same
  Discord-OAuth / DO-under-local-dev gap as every prior live-bids change;
  build + `tsc` + `go build`/`go vet`/`go test` + binding regen all clean.

**Live bids: Phase 15 + 16, 2026-08-30 → 09-01 (no migration; needs a
deploy + a parser release).** Phase 15 (parser, `../seekers-epgp-parser`):
the Bids tab is a live round view (`CaptureBids` returns a `BidRound`, a
poller re-emits `bids:round` as tells land, `EndBidRound` freezes it for
review); PQ-Companion-style game-folder log auto-detect
(`internal/eqlogs`, follows character swaps mid-raid); `cmd/simlog`
replays a raid (bids + `/who`) into a throwaway EQ log for local testing.
Also: `POST /api/officer/bids` no longer calls the DO at all — that was
the last Next-route→DO loopback hop and it crashed `wrangler dev` under a
live round (see "Hard-won gotchas"). Phase 16: `/live-bids` is a
responsive card grid; a finalized round **lingers** as a dimmed `WON`
card (`Round.state: "collecting" | "resolved"`) instead of vanishing —
cleared by the same officer opening their next item (`/push` sweeps only
*that* officer's resolved rounds), a ~20 min timer, or a member
`POST /api/live-bids/dismiss`. New `POST /api/officer/live-bids/resolve`
(officer key) drives it, called by the parser's `SubmitBids`. All
verified via endpoint smoke against local `wrangler dev` (push / resolve /
re-drop / new-item / clear / dismiss); the on-page behaviour needs a real
browser session to eyeball (same gap as every live-capture change here).

**Parser: auto-start bid rounds from "send tells", 2026-08-30
(`../seekers-epgp-parser`, released as v0.1.1).** The Bids tab needed the
officer to type the item name and click Capture. Now a background log
watcher (`app.go` `startAnnouncementWatch`, 4s poll) detects the officer's
OWN `<item> send tells` line via `parse.DetectAnnouncement` +
`extractItemName`, emits a `bids:announcement` Wails event, and
`BidsPanel.tsx` auto-runs the existing capture + live push with the item
name pre-filled/editable. Only `ownChatRe` lines count, so another
officer's concurrent announcement in the same channel never triggers it.
Mid-round detections show a Switch/Ignore banner rather than clobbering.
Manual Capture button kept; Determine Winner unchanged (non-destructive —
live push runs until Submit, per the leader's call). `config.Settings.
AutoDetectBids *bool` (nil ⇒ on) + a Settings checkbox + `SetAutoDetectBids`
bound method. Unit-tested against the real `bids_sample.txt`; the
watcher→event→auto-capture integration is **not** verified against a live
in-game session (same gap every live-capture change here has). Needs a
`wails3 generate bindings` — done, committed.

**Live bids: multi-officer / multi-item rework, 2026-08-30 (no migration —
the DO has no stored schema; needs a deploy + a parser release).** The
`LiveAuctionSession` DO held ONE `itemName` + `bids[]`, so a second officer
pushing a different item wiped the first. Real raids run 1-10 officers,
each on their own API key, collecting different items in parallel
(confirmed with Luna). Now:
- DO holds `rounds: Map<itemKey, Round>` (keyed by lowercased item name;
  two officers never collect the same item at once). Each round carries the
  officer's name, its bids, `lastSeenAt`, per-round `live`/`idle`. `live`
  for 90s after the last signal, then `idle`; hard-removed after 5 min so a
  brief parser blip doesn't lose collected bids. Alarm sweep is debounced
  (`ALARM_DEBOUNCE_MS`). Protocol is now `{type:"state", rounds:
  RoundView[]}` (dropped the single-round shape and the `cleared` message).
- **`/api/live-bids/state` + `/api/officer/live-bids/{push,heartbeat,clear}`
  moved into `custom-worker.ts`** — see the gotcha above; this is what
  fixes the local-dev crash (DO RPC no longer crosses the Next loopback)
  and also drops a hop in prod. `verifyOfficerApiKey(request, env, cf)`
  added to `api-key-auth.ts` for the out-of-Next caller. The four Next
  route files under `src/app/api/{live-bids,officer/live-bids}/` were
  deleted. `POST /api/officer/bids`'s finalize clear stays a Next route
  (one call, not a loop) but now passes `{itemName}` so it only clears its
  own round.
- `LiveBidsView.tsx` stacks all open rounds, each headed by item + officer.
- Parser (`../seekers-epgp-parser`): `HeartbeatLiveBids`/`ClearLiveBids`
  now take an `itemName`; idle heartbeat backs off from every 5s to every
  ~20s (`heartbeatEveryNIdleTicks`), new tells still push immediately — keeps
  per-key request volume low with many officers polling at once. No `App`
  method signature changed, so no `wails3 generate bindings` needed.
- **Free-tier load:** SQLite-backed DO (already `new_sqlite_classes`); no
  `ctx.storage` data writes on the hot path; broadcasts are in-memory
  fan-out (50 viewers cost the same as 5); worst case ~21k DO requests on a
  raid night, under the 100k/day free limit, and the heartbeat backoff cuts
  it further. WebSocket Hibernation keeps idle viewers unbilled.
- **Not** using a Postgres sync engine (Zero/Electric/PowerSync) — all need
  Postgres + an always-on sync server, which breaks the Workers/D1
  free-tier model. Durable Objects *are* the Cloudflare-native answer here.
- Verified: full build clean; 3 simulated officers × different items ×
  push every 2s for 2 min (129 requests) with the preview server staying
  up throughout (it died in <15s under this load before); push/heartbeat/
  clear/validation/401/403/426/429 all return correct codes. **Not**
  browser-verified (no Discord OAuth in this env).
- **Deployed to production 2026-08-30** — Worker version
  `84be7bdf-c693-4f96-b6cd-738873c04fd7`, bundle 2537.99 KiB gzipped
  (under the 3072 cap). Verified live at seekers.fetchinglogic.com: `/`
  and `/login` 200; `/roster`/`/live-bids`/`/access-denied` 307;
  `GET /api/live-bids/ws` (no Upgrade) 426 and `GET /api/live-bids/state`
  401 (both proving custom-worker.ts intercepts them ahead of Next in
  prod); `POST /api/officer/live-bids/{push,heartbeat}` 401 without a key;
  `POST /api/officer/bids` 401 (Next routing still fine through the
  custom-worker fallthrough). Parser side shipped as **v0.1.0** — the
  repo's first tagged release
  (github.com/jasonsoprovich/seekers-epgp-parser/releases/tag/v0.1.0),
  `seekers-epgp-parser-windows-amd64.exe` + `SHA256SUMS`.

**Roster readability + leader-initiated guild removal, 2026-08-29 (local
only — no migration, no deploy)**: three unrelated tweaks in one pass.
- **Roster alt rows** (`src/components/roster/RosterTable.tsx`): alts now
  render as a shaded band (`bg-neutral-900/40`) directly under their main
  with an emerald left-accent rule, a deeper name indent, and a `↳` marker,
  so a main's alt group reads as one unit instead of blending into the next
  main's row. The `Claimed` ✓ column was removed and `Owner` moved to the
  last column (it carries the same signal — a name == claimed, dim
  "Unclaimed" == not). Dead `isClaimed` field dropped from `RosterRow` and
  `roster/page.tsx`.
- **"Remove from guild"** — a player-level access action, deliberately
  distinct from a character's own `removed` status (which stays pure
  in-game/roster housekeeping and never affects a person's access on its
  own, confirmed with the leader). New leader-only (`canManageRoles`)
  `removeMemberFromGuild`/`reinstateMember` server actions
  (`src/app/(app)/admin/actions.ts`) + `RemoveMemberButton`
  (`ConfirmDialog`, can't remove self, last-leader guard) in `/admin`'s
  Members & Roles list. Removal sets `players.status = 'departed'` and drops
  `users.role` to `member`; reinstate flips status back to `active` but does
  NOT restore the role (a leader re-grants deliberately). Enforcement:
  `isMemberAllowed` (`src/lib/discord-verify.ts`) now also rejects
  `playerStatus === 'departed'`, checked via a `players` left-join in
  `(app)/layout.tsx`'s existing one-query gate and in `fetchIsMemberAllowed`
  (the WS path). A departed member is bounced to `/access-denied`, which now
  shows an "Access removed — contact a leader" variant. `players.status`
  `'inactive'` does NOT block access — only `'departed'` does. A NULL
  playerStatus (no players row) is not a denial — falls through to the
  Discord check.
- **Discord-removal access cutoff** stays login-time (the existing Phase 6
  `session.create.after` re-verification) — leader confirmed per-login is
  enough, no per-request/periodic re-check added. Only verified
  `/access-denied`'s "you're actually fine" early-redirect doesn't fire for
  a departed player.
`tsc` clean; `isMemberAllowed` re-checked against hand cases (departed →
false even with a valid role + discordVerified; inactive/null → allowed).
`npm run build` + preview serve `/roster`/`/admin`/`/access-denied`
correctly (307 unauthenticated). **Not browser-verified** — same
Discord-OAuth gap as every prior leader/member-page change here.
**`npm run verify` fixture failures seen 2026-08-30 — root-caused, NOT this
change, and partly hardened.** Two independent things were stacked on top of
each other, which is why the first read of it (wall-clock cycle rollover
alone) was incomplete:
  1. **Wall-clock drift** — `computeEpgpTotals` resolved the "current cycle"
     from real `new Date()`. UTC crossing into 2026-08-30 moved the current
     cycle 66→67 (the local seed's `cycles` has a 1-day gap 08-29→08-30), so
     `cycleStart` jumped 2026-08-16 → 2026-08-30 and ~2 weeks of veteran EP
     fell under the legacy §1a 20% haircut — `rawEp` unchanged, ep/epDecay
     split moved. **Fixed:** `computeEpgpTotals(db, { asOf })` (default real
     now; every production caller uses the default) + `getEpgpSettings(db,
     asOf)`; the harness now pins `FIXTURES_AS_OF = 2026-08-21T12:00Z`
     (`scripts/golden-fixtures.ts`), the date the `expected` values were read
     off the sheet, so it tests the decay *math* deterministically instead
     of drifting every cycle boundary.
  2. **The remaining 5 failures after the pin are local test data, not a
     bug** — 42 `ep_ledger` rows (`source='parse'`, `Raid - End`, 50 EP each,
     `created_at 2026-08-30 03:43:40`) from a real attendance capture
     submitted through the parser app during live testing this session. The
     5 that "fail" (Aransur/Ammaru/Takkisina/Luna/Kaalos) are exactly the
     golden-fixture characters that were in that `/who` capture — each +50
     raw EP, decay unchanged. Aazimoku (also a veteran-decay fixture) wasn't
     in the capture and still passes. `npm run snapshot -- restore
     before-test` clears it; on a clean seed the harness is 13/13 with the
     pin.

**Alt→main roster grouping fix, 2026-08-29 (local only — no migration, no
deploy)**: on local dev the roster showed alts as loose top-level rows even
though their `char_type`/`player_id` were correct. Root cause:
`scripts/derive-players-from-sos-bot.ts` set `players.main_character_id` (the
account-level pointer) but never `characters.main_character_id` — and
`RosterTable` nests an alt under its main strictly via
`characters.main_character_id` (`src/components/roster/RosterTable.tsx`, the
`groups` memo), not `player_id`. Confirmed against local D1: 446 alts, 445
with `main_character_id` NULL. Toryn's dump carries the link implicitly —
characters grouped by `discord_id`, one `char_type='Main'` per clean group —
so the derive script now backfills `characters.main_character_id` for every
`alt` row from its group's resolved main. Runs **independently of the
`player_id` guard** (so a re-run repairs an already-derived DB), only writes
when the column is NULL (never clobbers a leader's manual link or a
`swapMainCharacter`), and mirrors that function's invariant — a main keeps
`main_character_id` NULL, mules aren't nested. Ambiguous groups (0 or 2+
mains — 27 of 243) stay NULL, same as `players.main_character_id` already
does there, already flagged in `players.note` for leader review. Dry-run
report gained an `Alt→main links to backfill` line. Applied to local D1
(`--commit`): alts with NULL main 445 → 41 (all 41 in ambiguous/noted
groups, zero in clean groups); every backfilled alt points to a real `main`
in the same player. `npm run verify` 13/13 and
`npm run verify:player-reconciliation` 697/697 unchanged — no EPGP impact
(`computeEpgpTotals` groups by `player_id`, untouched). Script-only change;
production D1 is re-derived by re-running this script, no migration.

**Nav/security restructure, 2026-08-25 — migration 0023 applied to remote
D1 and deployed to production the same day** (Worker version
`a01142ce-a512-4bb0-abc9-f2034b4a56c4`, live at
seekers.fetchinglogic.com). Bundle was 2531.40 KiB gzipped
(`wrangler deploy --dry-run`), comfortably under the Free plan's 3072 KiB
cap. Verified live against the real production domain: `/` and `/login`
200; unauthenticated `/roster`/`/admin`/`/epgp/sql`/`/epgp/ledger`/`/bank`/
`/keys`/`/live-bids` all 307 to `/login`; unauthenticated
`GET /api/live-bids/state` and `POST /api/officer/live-bids/heartbeat`
both 401; `GET /api/live-bids/ws` with no `Upgrade` header 426 (the
custom-worker interception still correct); `SELECT ... FROM v_characters`
against remote D1 returned real character rows, and no `v_sessions`/
`v_accounts`/`v_apikeys` view exists. Outside PLAN.md's own numbered
phases (this was
a leader-requested security audit + follow-on UX restructure, not a
PLAN.md §11 task) — "Phase A/B/C/D" below is that separate work's own
internal naming, not a PLAN.md phase number. Six commits, `git log` has
the full detail; summary:
- **Phase A (security)**: `/epgp/sql` (the officer SQL sandbox) validated
  query *text* but ran against the whole D1 database, including
  better-auth's own `sessions`/`accounts`/`apikeys` tables — an officer
  could `SELECT token FROM sessions` or pull another member's plaintext
  Discord OAuth tokens straight out (why they're plaintext: see
  `src/auth/index.ts`'s comment). Migration 0023 adds `v_`-prefixed
  read-only views over exactly the EPGP tables (none over the auth
  tables); the sandbox's validator now tokenizes the query and requires
  every FROM/JOIN target to be a view or a query-local CTE — a naive regex
  version of this was tried first and confirmed, against local D1, to miss
  an aliased comma-join (`FROM v_characters c, accounts a`), which also
  defeats a query-plan-based check (`EXPLAIN QUERY PLAN` reports the
  alias, not the real table name) — worth remembering if this validator is
  ever touched again. App Key / SQL Sandbox links moved off Roster (every
  member could see them) onto `/admin` (already officer+-gated). All 8
  `window.confirm()` call sites migrated to a new `ConfirmDialog` (real
  `<dialog>`, focus trap, Escape-to-close); claim approval, which had no
  confirmation at all, gained one too. Fixed two ledger bugs found during
  the audit: `updateLedgerEntry`/`deleteLedgerEntry` never invalidated the
  EPGP totals cache (stale `/roster` after an edit/delete), and
  `updateLedgerEntry` didn't sync `pointsNominal`/`pointsAwarded`.
- **Phase B**: top `NavBar` replaced with a left `Sidebar` (logo pinned
  top, links scrollable middle, account block pinned bottom); nav links
  gained a declarative `roles` field instead of one ad-hoc ternary.
- **Phase C1**: `/epgp/ledger` grew from 2 tabs (EP/GP) to 4 — added Bids
  History (net-new: `bids` had been write-only since Phase 12, nothing had
  ever read it back) and folded in Audit Trail (was its own unlinked
  `/epgp/ledger/audit` route, now removed). Promoted to a top-level
  sidebar entry. Extracted the page's and `/api/officer/ledger`'s
  identical duplicated query into `listLedgerRows`
  (`src/lib/epgp/ledger-list.ts`).
- **Phase C2**: Sky Bank merged into `/bank` as a second tab
  (`sky_bank_rewards`/`sky_bank_stock` share no columns with
  `bank_holdings`, so kept as its own tab rather than forced into that
  shape). `/keys` deliberately left as-is — `character_key_flags` (the
  EmpVT/ST half) has no other reader, so Sky Bank content is duplicated
  onto `/bank`, not moved.
- **Phase D**: the live-bids Durable Object had no notion of time at
  all — an open WebSocket against a round that ended hours ago still
  showed a green "Live" pill. Added `lastSeenAt`/`pusherUserId` +
  `status: "live"|"idle"` (90s TTL via `ctx.storage.setAlarm()` — a timer
  schedule, not a data write, so this doesn't reintroduce the per-push
  storage cost the DO's original design deliberately avoided), a
  `POST /heartbeat` (parser app's poller sends this on a quiet tick
  instead of going silent) and `GET /state` (backs a new Refresh button —
  previously the DO had no plain read path at all). Also fixed a real bug:
  `POST /api/officer/bids`'s GP-charge loop returned before ever reaching
  the DO clear on a per-winner failure, even though `loot_events`/`bids`
  were already durably committed by that point — wrapped in `finally`.
  Companion parser-app change (`../seekers-epgp-parser`) sends the
  heartbeat and an explicit clear on quit.

Every phase verified against a real local server (`wrangler dev --local`
or `opennextjs-cloudflare preview -c wrangler.dev.jsonc`, whichever
actually resolves the `LiveAuctionSession` DO binding — a raw `wrangler
dev --local` invocation left it unresolved) with real signed better-auth
session cookies and a real minted officer API key (same
mint-directly-against-local-D1-then-sign-with-the-real-local-secret
technique, not a bypass), not just `tsc`/`build`. **Migration 0023 applied
to remote D1 and deployed to production 2026-08-25** — see the live-domain
verification above.

**Current focus: PLAN.md §11 Phase 12 (live bids) is COMPLETE as of
2026-08-24 and deployed to production the same day** (Worker version
`ce4c9c51-988e-4386-8ae8-7b9034b24304`). See below for the writeup.
Phase 11 (quest flags) is also COMPLETE and deployed to production, same
day (Worker version
`ad6f4eca-587e-4583-aa8f-d09f9da3d8df`) — see below for that writeup, and
the Webpack-build entry above "Commands" for why a deploy had actually been
silently broken since before Phase 5. Phase 10 (character claiming rework)
is also complete, same date. Phase 9 (Discord bot, `../seekers-bot`) tasks
9.1-9.4 are also done, only 9.5 (a leadership decision, not code) open
there — see that repo's own `CLAUDE.md`. Phases 0-6 are complete (4.2b
deliberately not implemented — see below and PLAN.md §16). Both hard
deadlines so far (expansion decay 9/30, global decay cutover 10/17) already
met, by Phase 2 and Phase 5 respectively.

**Phase 12 tasks 12.1/12.2/12.4/12.5 — live bid Durable Object +
WebSocket, 2026-08-24**: `src/durable-objects/live-auction-session.ts`
(`LiveAuctionSession`, single guild-wide instance via a fixed
`idFromName`) holds in-flight bids purely in memory — no `ctx.storage`,
no D1, on this path at all (PLAN.md §15), which is what makes constant
live-viewing free-tier-safe. Uses the WebSocket Hibernation API
(`ctx.acceptWebSocket`) so idle viewers don't keep it billed as active.
`POST /api/officer/live-bids/push` (task 12.2, existing
`requireOfficerApiKey`) resolves the bidder's current priority the same
way `/api/officer/bids` already does per-entry, then forwards to the DO;
`POST /api/officer/bids` (task 12.5) clears the DO on finalize,
best-effort, after its own inserts succeed — that route is still the
unchanged source of truth. New `/live-bids` page (task 12.4, every role —
same transparency call as `/roster`/`/bank`/`/keys`), a client component
opening a WebSocket and rendering bids ranked the same way the parser
app's own "Determine Winner" would (tier first, then priority).

**Real architectural finding, not just a design choice**: a Next.js Route
Handler cannot itself return the WebSocket upgrade. OpenNext bridges API
routes through a Node-`http.ServerResponse`-style shim (for Node-API
compatibility) that rejects any response status outside 200-599 — the 101
Switching Protocols a WebSocket upgrade needs never reaches the real
Workers runtime, it 500s inside that shim first. Confirmed by hand: a
first attempt at `src/app/api/live-bids/ws/route.ts` crashed exactly this
way under a real local `wrangler dev --local` run. Fixed by moving the
`/api/live-bids/ws` handling into `custom-worker.ts` — a hand-written
entrypoint (`main` in `wrangler.jsonc`/`wrangler.dev.jsonc`) that wraps
the OpenNext-generated `.open-next/worker.js` (regenerated every build,
which is why this wrapper — not that file — is what's committed) and also
exports `LiveAuctionSession` so wrangler can find it. It intercepts that
one path *before* Next's router (and the shim) ever sees the request;
every other route, including the JSON-only `POST
/api/officer/live-bids/push`, still goes through Next exactly as before.
Session auth for the WS path can't reuse `next/headers`' `headers()`
outside a Next request context either, so `custom-worker.ts` calls
`createAuth(env, cf).api.getSession({ headers: request.headers })`
directly — same underlying call `src/lib/session.ts`'s `getSession()`
makes, just without the Next-specific header helper. The guild-membership/
deny-list gate itself (`isMemberAllowed`) was pulled out of
`(app)/layout.tsx` into `src/lib/discord-verify.ts` as a pure function
over an already-fetched row (`fetchIsMemberAllowed` wraps it with the one
extra query a caller with nothing pre-fetched, like this one, needs) —
deliberately *not* a single shared DB-fetching helper, since that would
have added a second D1 round-trip to the layout's existing one-query gate
on every single page navigation just to save a few lines in a path that
runs once per WebSocket connection, not once per request.

**Verified live against a real local `wrangler dev --local` run**, not
just `tsc`/build: unauthenticated push → 401, unauthenticated WS upgrade
attempt → 401 (not the 500 above), a WS upgrade with a temporary
query-param bypass (session cookies can't be forged without reverse-
engineering better-auth's HMAC signing, and there's still no real Discord
OAuth in this environment — same gap as every other session-gated route
built this session) completing the full 101 handshake and receiving both
the initial `{type:"state"}` snapshot and a live broadcast pushed mid-
connection, and a real finalize through `POST /api/officer/bids` writing
the actual `loot_events`/`bids`/`gp_ledger` rows (then deleted, along with
a throwaway officer API key, to leave local D1 clean). The bypass was
reverted before committing — the shipped code always requires a real
session. `npm run build` (webpack) and a full `npx opennextjs-cloudflare
build` + `wrangler dev --local` smoke pass both clean; `/` and unauth
`/roster`/`/live-bids` still 200/307 as expected, no regression.
No D1 migration needed (the DO has no storage). **Deployed to production
2026-08-24** — Worker version `ce4c9c51-988e-4386-8ae8-7b9034b24304`.
Before deploying, checked the real bundled size via `wrangler deploy
--dry-run` rather than trusting the un-bundled `.open-next/worker.js`
template file's own size (a red herring — it's just an entrypoint with
relative imports wrangler's own bundler resolves at deploy time, not the
final artifact): 2529.93 KiB gzipped, comfortably under the Free plan's
3072 KiB cap with ~540 KiB headroom, and the dry run's own binding list
confirmed `LIVE_AUCTION_SESSION` resolved correctly. The real deploy
produced the same "class not exported" warning seen locally during
`getPlatformProxy` use — from OpenNext's own internal cache-population
pre-step checking against the bare `.open-next/worker.js`, not the actual
deployed artifact; the deploy's own final binding list confirmed
`LIVE_AUCTION_SESSION (LiveAuctionSession)` resolved correctly, same as
the dry run. Verified live against the real production domain: `/` and
`/login` 200, unauthenticated `/roster`/`/live-bids` 307 to `/login`,
`GET /api/live-bids/ws` with no `Upgrade` header 426, unauthenticated
`POST /api/officer/live-bids/push` 401 — no regression, every new Phase 12
route gated exactly as designed. **Not yet verified with a real WebSocket
connection or a real officer push against production** — same
Discord-OAuth-credential gap as everywhere else; the full WS
handshake-plus-broadcast path was proven locally instead (see above), and
production auth was never bypassed to re-prove it live.

**Phase 12 task 12.3 — parser app pushes bid tells live,
2026-08-24** (`seekers-epgp-parser`): `App.startLiveBidPush` (`app.go`)
polls the log every 5s for tells newly detected since the last poll
within the same `[startAt, now)` window `CaptureBids` itself scans, and
pushes each new one via a new `officerapi.Client.PushLiveBid` (`POST
/api/officer/live-bids/push`). Diffing is a plain count comparison
against the previous tick's `len(candidates)`, not a value-based diff —
correct because `parse.CaptureBids` re-scanning the same `startAt` against
a strictly-growing log file always reproduces the previous tick's result
as an exact prefix, new tells only ever appended at the end. Wired in at
the two natural lifecycle points: `CaptureBids` starts (or restarts) the
poller — a new item name implies the previous round is over, same
reasoning the DO's own `/push` handler uses server-side to reset — and a
successful `SubmitBids` stops it (the finalize route already clears the
DO's state; this just stops the Go side from continuing to poll into a
round that's already done). `App.liveBidsCancel` is guarded by a mutex
since Capture and Submit are both Wails-bound methods JS can call
back-to-back. Best-effort throughout, same as the app's other background
calls (`FetchKnownItems`, the startup settings fetch): a push failure is
silently skipped, `CaptureBids`/`SubmitBids` stay the real record
regardless of whether this side channel works. No exported `App` method
signature changed, so no `wails generate module` was needed — confirmed by
a full `wails build` producing zero binding diff.

**Verified live**, not just `go build`/`go vet`/`go test`: a throwaway
`app_manual_test.go` (this repo's own established pattern for anything
touching `app.go`) ran the real `CaptureBids`/`startLiveBidPush` against a
synthetic log file and a real local `wrangler dev` instance (temporarily
pointing `officerapi.ServerURL` at `localhost:8787` instead of production
— reverted immediately after, confirmed by diff — since this app has no
env-based server override, by design, per that constant's own comment).
Two tells 7 seconds apart (one present at the initial capture, one
appended mid-poll to simulate a live tell arriving) produced exactly two
`POST /api/officer/live-bids/push 200`s in the tracker's dev log — proves
both the initial push and the append-diff detection, not just that the
endpoint can be hit once. This machine already had a real production
config.json (a real officer's API key) sitting in
`~/Library/Application Support/seekers-epgp-parser/` from earlier use —
backed up, swapped for a throwaway local-only key for the test, and
restored byte-for-byte afterward (diffed against the backup to confirm);
the throwaway key was deleted from local D1 when done. **Not verified
against a real Discord login or real in-game "send tells" tells** — same
constraint as every session-gated/live-capture path built this session.

**Found while starting Phase 11**: the guild's real `SoS - EPGP.xlsx` is
sitting in `~/Downloads` on this machine — the same file
`scripts/import-epgp.ts` already reads, and what Phase 8 task 8.2 (migrate
the sheet's own Spell Bank/Item Bank tabs) was blocked waiting on. Only used
it for Phase 11's three tabs (EmpVT Key List/ST Key List/Sky Bank) this
session — 8.2 is still open, noted here so it isn't mistaken for "no input
available" next time it comes up. (8.4 is a separate blocker — real mule
*inventory* exports, not this file — still genuinely unavailable.)

**Phase 7 (officer app auto-update) is COMPLETE as of 2026-08-23.** (Old
production-snapshot Phase 7 is now Phase 14 — moved to last, same date;
see below.) The leader wants every remaining phase (8 guild bank, 9 Discord
bot, 10 character claiming, 11 quest flags, 12 live bids, 13 Wails v3
migration) built and tested before committing to a go-live cutover date;
going live is now the final one-time event, not a mid-plan milestone. Prep
for the eventual Phase 14 (dry-run `seed-from-xlsx`/harness against a
current sheet export, a go-live runbook) can happen anytime without
freezing the live sheet or touching a fresh remote D1.

**Phase 8 (guild bank) in progress as of 2026-08-24** — 8.1 (migration), 8.2
(sheet-tab migration), 8.3 (parser, `seekers-epgp-parser/internal/
bankexport`), 8.5 (browse/search) and 8.6 (manual add/edit) done; only 8.4
(the real per-mule import endpoint) still needs an input this session
doesn't have — real mule Zeal exports (`data/imports/bank/`). **8.5/8.6
shipped in commit `f420b79` but weren't checked off in `PLAN.md`/recorded
here at the time** — caught and fixed while starting Phase 9, see
`PLAN.md`'s own 8.5/8.6 entries for what they cover.

**Phase 8 task 8.2 — sheet Bank tabs migrated into `bank_holdings`,
2026-08-24**: turned out not to actually be blocked — the note above (and
Phase 11's own writeup) had already found the real `SoS - EPGP.xlsx`
sitting in `~/Downloads` on this machine, just hadn't circled back to use
it for this task yet. `scripts/import-bank-tabs.ts` (same SQL-emitting,
non-destructive shape as `import-epgp.ts`/`import-quest-flags.ts`) parses
the "Spell Bank" and "Item Bank" tabs — "Sky Bank" was already split out
into its own tables by Phase 11, so only these two feed `bank_holdings`
now, not three. Splits each row's comma-joined `Notes` location list
(`"General6-Slot5, Bank1-Slot3, ..."`) via the same `BAG_SLOT_RE`/
`BAG_CONTAINER_RE` shape as the sibling `pq-companion` repo's
`inventoryLocations.ts` (a bare `"Bank20"` with no `-SlotN` means the item
occupies the bag's own top-level slot — `slotIndex 0`, per the schema's own
comment). Verified against the real data *before* writing the split logic:
every row's location-token count either equals its QTY exactly (one
non-stacking item per slot — true for all 283 Spell Bank rows with any
locations at all) or is exactly 1 (one stack holding the full QTY) — except
two Item Bank rows (Flawless Diamond, Pristine Emerald, both qty 21 across
2 locations) that fit neither pattern, given a documented heuristic
(stack-cap 20, remainder on the last slot) rather than silently guessed at
in code, and called out in the script's own console output on every run.
Result: 968 physical-stack `bank_holdings` rows (888 spell, 80 item) from
283 Spell Bank + 78 Item Bank sheet rows. 12 distinct mule/holder names
found; 6 already existed as `characters` rows (Darkclaw, Darkseller, Luna,
Punk, Sandrian, Darkspeed), 6 didn't (Lunamule, Intspelzone, Intspelztwo,
Wiszpellz, Veliousmule, Sosbanker) — created as new `char_type='mule'`
characters (§4c), owned by whichever real character the sheet's "Officer"
column paired them with (Luna → Lunamule; Aransur → Intspelzone/
Intspelztwo/Wiszpellz/Veliousmule; Avenn → Sosbanker) — confirmed each
holder name maps to exactly one officer across the whole sheet before
relying on that, not assumed. Idempotent by the schema's own delete-and-
replace-per-holder design (§3/§4f), scoped to `source = 'import' AND
import_id IS NULL` so a later real Zeal-export import (task 8.4) can never
be clobbered by a re-run of this sheet migration, and vice versa.
**Verified live against local D1** (snapshotted first via `npm run
snapshot -- save pre-bank-tabs-import`): zero unique-constraint
`(holder_character_id, container, slot_index)` collisions across the full
parsed set; re-running the script and reapplying the emitted SQL produced
byte-identical totals (968 rows, same per-category/per-holder counts) and
did not create a duplicate mule character, confirming idempotency; a
throwaway script called `listBankHoldings` (the `/bank` page's own query,
task 8.5) directly against local D1 and got back all 968 rows correctly
joined to their holder with zero code changes needed; `npm run verify`
stayed 13/13 (no regression — this only touches `characters`/
`bank_holdings`, neither read by the harness). **Not verified in an actual
browser** — same Discord-OAuth-credential gap as every other page built
this session; the query layer itself was proven directly instead.

**Shipped:**
- **Phase 12 — live bids, 2026-08-24**: `LiveAuctionSession` Durable
  Object + WebSocket fan-out, the officer-app push endpoint, the parser
  app's own live-push polling, the website's `/live-bids` view, and
  clear-on-finalize — see the full writeup above "Current focus", not
  repeated here. **Deployed to production 2026-08-24** (Worker version
  `ce4c9c51-988e-4386-8ae8-7b9034b24304`), confirmed live at
  seekers.fetchinglogic.com.
- **Phase 11 — quest flags, 2026-08-24** (migration 0022): resolves task
  11.1's open question (PLAN.md §16) — `character_pop_flags` stays
  untouched, three new tables instead. `character_key_flags`
  (characterId, flagKey, label, done, loggedBy, source) covers EmpVT
  (`empvt_emp`/`empvt_vt`, two fixed flags) and ST (a slugified key-item
  name per row — no fixed catalog exists for these, an officer just types
  a new one whenever a key drops); `sky_bank_rewards` and `sky_bank_stock`
  cover the "Sky Bank" tab's two unrelated blocks (a No-Drop quest-reward
  catalog with no character column at all, and a hand-counted guild-wide
  stockpile) — see PLAN.md's Phase 11 write-up for the full "why not one
  table" reasoning.
  `scripts/import-quest-flags.ts` parses the real `EmpVT Key List`/
  `ST Key List`/`Sky Bank` tabs (found sitting in `~/Downloads` this
  session — see above) into the same non-destructive SQL-emitting shape as
  `import-epgp.ts`; `character_key_flags` upserts guarded
  `WHERE source = 'import'` so a future manual edit survives a re-import,
  `sky_bank_rewards`/`sky_bank_stock` are whole-table delete-and-replace
  every run (small guild-wide catalogs, no per-row provenance worth
  protecting). `npm run verify:quest-flags` re-resolves every sheet name
  against live `characters` and lists exactly which didn't match, so a
  name miss is visible instead of a silent no-op (the SELECT-based INSERT
  has no `orphaned`-row concept to catch it otherwise).
  Two real data quirks handled, not guessed at: EmpVT sometimes annotates
  an alt as `"Name (Main)"` — confirmed against local D1 that the base
  name before the paren always matches a real character before relying on
  it; Sky Bank's reward block has 23 items appearing 2-3 times with
  identical item **and** quest name every time (a sheet re-paste, not two
  quests sharing a name — checked, not assumed) — last-row-wins rather
  than erroring on the unique index.
  New `/keys` page (read-only, every role — same transparency call as
  `/roster`/`/bank`/`/progression`): a Keys tab (94 of 783 characters have
  any EmpVT/ST flag — listed by character, not an all-783 table like
  Progression's, since this content is opt-in rather than universal) and
  a Sky Bank tab (reward catalog + stock, both searchable).
  **Verified live against local D1** (snapshot/restore around the import
  run, exact row-count math checked by hand — 199 `character_key_flags`,
  89 `sky_bank_rewards`, 148 `sky_bank_stock`; query layer re-run via a
  throwaway script against the same DB, not just `tsc`/`next build`).
  **Not verified in an actual browser** — same Discord-OAuth-credential
  gap as every other leader/member page built this session.
  **Applied to remote D1 and deployed to production, 2026-08-24**
  (migration 0022; Worker version `ad6f4eca-587e-4583-aa8f-d09f9da3d8df`,
  live at seekers.fetchinglogic.com — confirmed both `/` and `/login`
  respond 200 post-deploy). This deploy also surfaced and fixed an
  unrelated, pre-existing blocker — see the Webpack-build note above
  "Commands": the compiled Worker had quietly been over the Free plan's
  3 MiB size cap since Phase 6, and no deploy had gone out since
  2026-08-22, so Phases 5-11's changes only went live together, today,
  once that was fixed. Manual add/edit for these flags (mirroring
  Phase 8's 8.6) wasn't in this phase's literal task list — left as a
  follow-up.
- **Phase 10 — character claiming rework, 2026-08-24** (migration 0021):
  `src/lib/players.ts` wires the `players` table (built in Phase 3, but
  never actually used by anything until now) into login, claiming,
  character creation, and a new leader-only main swap.
  `resolvePlayerForUser` (task 10.1) resolves `users.discordId` to a
  `players` row on every login — reusing a dump-seeded row (the common
  case for an established member) or creating one (a member who joined
  after Toryn's dump) — wired into the same `session.create.after` hook
  Phase 6's guild-membership check already uses. `attachCharacterToPlayer`/
  `createStandalonePlayer` (task 10.2) close a real gap PLAN.md §16 flagged
  during Phase 3: **every** character-creating write path now sets
  `player_id` — claim approval, `/characters/new`, and the officer app's
  "no match" character creation (`api/officer/characters`), which
  previously made every character it created `player_id`-less regardless
  of path, not just the one §16 called out. An alt of a known main shares
  that main's player outright; a brand-new main gets its own standalone
  player (same shape task 3.5 already used for sheet-only characters).
  `swapMainCharacter` (task 10.3) is leader/admin-only (`canManageRoles` —
  the same bar as role promotion, a bigger call than claim approval's
  officer-level `canManageAnyCharacter`) — updates
  `players.main_character_id` and keeps the affected characters'
  `char_type`/`main_character_id` in sync (§4c: "char_type is display
  metadata kept in sync"), new `/admin` section mirroring the existing
  Members & Roles list. EP/GP is untouched by construction, not by
  care — `computeEpgpTotals` has grouped by ledger `player_id` since task
  3.11, and this function never writes to either ledger.
  `scripts/verify-player-reconciliation.ts` (task 10.4,
  `npm run verify:player-reconciliation`) reports drift between
  `sos_bot_staging` (Toryn's old bot's dump — the one other source that
  ever asserted a character→discord_id relationship) and live state:
  OK / claimable (dump-asserted, character still sits on a standalone
  player — resolves itself once the right person logs in and claims it,
  not an error) / conflicts (two different real discord_ids asserted for
  the same character — flagged for a human, never guessed at). 697/697 OK
  against the current snapshot. **Verified live against local D1, not just
  `tsc`/`build`**: a real seeded-but-never-linked player row (Osui/Nariana,
  discord_id `109700895498862592` — real data already in the local
  snapshot) correctly links on a simulated first login and is idempotent on
  a second; attaching a second real character bootstraps
  `main_character_id`; a swap correctly repoints `char_type`/
  `main_character_id` on both the old and new main and rejects a character
  that doesn't belong to the player; `createStandalonePlayer`'s two-step
  insert (character can't reference a player that doesn't exist yet, and
  vice versa) produces a correctly self-referencing player. All via
  throwaway scripts, snapshot-restored after. **Not verified**: no real
  Discord login exists in this session to exercise
  `resolvePlayerOnLogin`'s hook wiring itself (same constraint every prior
  auth-hook change here has had); migration 0021 not yet applied to remote
  D1.
- **Phase 9.1-9.4 — `seekers-bot` scaffolded, 2026-08-24** (`../seekers-bot`,
  new repo): a Cloudflare Worker Interactions Endpoint, not a gateway bot —
  full writeup in that repo's own `CLAUDE.md`. Short version: Ed25519
  signature verification (`discord-interactions`' `verifyKey`) and
  `/lookup_characters` (groups by `characters.player_id`, ordered
  `char_priority` then name, matching Toryn's old bot's output shape) both
  verified live against a real generated keypair and `seekers-tracker`'s
  own local D1 snapshot, not just `tsc`. D1 binding has no
  `migrations_dir` on purpose — that repo structurally can't run a
  migration. 9.5 (whether passive channel reading must be preserved) is
  still open, a leadership call.
- **Phase 8.5/8.6 — guild bank browse/search + manual add/edit,
  2026-08-24** (commit `f420b79`; checked off in `PLAN.md`/recorded here
  only while starting Phase 9, see above): new `/bank` page,
  `src/lib/bank/holdings.ts` + `BankBrowseTable` (search/category/mule/
  class-restriction/status filters, defaulting to `guild_bank`-only, same
  pattern as `RosterTable`), and officer-gated manual add/edit/delete for
  items no export captures.
- **Phase 8.1/8.3 — guild bank schema + inventory export parser,
  2026-08-24** (8.2/8.4 remain — both need real inputs this session
  doesn't have, see above): the leader shared two
  real Zeal inventory exports (one player's own characters, for format
  reference only, not guild mules) which settled what §9/Phase 8 had left
  open. `bank_holdings`/`bank_imports` migrated (§4f) with two small
  additions beyond its literal spec: `itemId` (free from the confirmed
  export format, more reliable than name matching) and a `category:
  'currency'` value. The bigger find: `SharedBank*`/`Bank-Coin` turned out
  to be account-wide, not per-character — confirmed byte-identical across
  two characters sharing an account — which would have made a naive
  per-mule import multiply-count every shared item and the banked
  currency. Resolved without any new schema/account concept: the officer
  app's per-import picker (task 8.3/8.4) will carry a "this mule reports
  SharedBank/Bank-Coin" toggle, on for exactly one mule per real account,
  stripping those rows from every other mule's payload before it's ever
  sent — see `data/imports/bank/README.md` for the full design write-up.
  `seekers-epgp-parser/internal/bankexport` ports the sibling
  `pq-companion` repo's already-tested `internal/zeal` parsing logic
  (same export format) rather than reinventing it — `ParseExport` splits
  a file into `Holdings` (per-character) and `SharedBank` (real slots
  1-10 + Bank-Coin, dropping the server's confirmed-dead 11-30), shaped
  to map directly onto a `bank_holdings` row. Tested against a checked-in
  synthetic fixture pair (the real reference exports are personal account
  data — verified once via a throwaway test per this repo's own
  convention, then not committed). Still needs real mule exports before
  8.2/8.4-8.6 (the actual import/browse/edit UI) can be finished.
- **Phase 7 — officer app auto-update, 2026-08-23** (`seekers-epgp-parser`):
  upgraded the existing notify-only `internal/updatecheck.Check` into a real
  download-verify-swap-relaunch, per §7 Option B (stay on Wails v2, add a
  Go self-update library — `github.com/minio/selfupdate`). New
  `updatecheck.Apply` fetches the latest release's assets, requires both
  the `.exe` and a `.sha256` sidecar to be present (aborts before
  downloading anything if either is missing — never applies an unverified
  binary), downloads the sidecar first to get the expected digest, then
  streams the exe straight into `selfupdate.Apply` with that checksum;
  `selfupdate` does the actual rename-and-swap (old exe renamed aside —
  hidden, not deleted, on Windows — new one moved into place), which is
  what makes overwriting a currently-running Windows exe possible at all.
  `App.InstallUpdate` (`app.go`) wraps `Apply`, then relaunches by spawning
  a new process from the same path and calling `runtime.Quit` — the
  officer never has to manually relaunch. `build-windows.yml` gained a
  `sha256sum` step publishing `seekers-epgp-parser.exe.sha256` as a release
  asset alongside the exe, on every build (not just tagged releases, since
  the digest has to exist before the tag that will reference it does).
  Frontend: the existing update banner gained an "Update & restart" button
  next to the manual "Download it" link (kept as a fallback — e.g. if the
  install directory isn't writable, `selfupdate`'s own `CheckPermissions`
  preflight catches that up front and the officer falls back to downloading
  by hand). Task 7.3 (config survives a swap) was a verify-only task,
  confirmed by inspection rather than a new test: `selfupdate.Apply` with
  an empty `TargetPath` resolves to `osext.Executable()`
  (`minio/selfupdate@v0.6.0/apply.go`), never anything under
  `os.UserConfigDir()` — the swap and the config file are on structurally
  separate paths by construction, not by luck. Task 7.4 (SmartScreen):
  wrote a new officer-facing `seekers-epgp-parser/README.md` (the repo had
  none before) documenting the "More info → Run anyway" click-through;
  didn't budget for a code-signing cert — that's a real-money decision for
  the leader, not a default to reach for, and the README says as much.
- **Phase 6 — Discord role deny-list, 2026-08-24**: closes a real gap this
  phase's own read of the code surfaced — `users.discordVerified` existed
  (Phase 5's OAuth setup) but nothing actually enforced it anywhere; every
  Discord-authenticated user, including `Orc Pawn`/`Guest`, had full site
  access. `SEEKERS_DISCORD_DENIED_ROLE_IDS` (new secret, comma-separated
  Discord role snowflakes — role names aren't derivable from the member
  API's response, so the Orc Pawn/Guest -> ID mapping has to live in config)
  + `isDeniedRole()`/`parseDiscordRoleIds()` (`discord-verify.ts`); enforced
  once, centrally, in `(app)/layout.tsx` ahead of every page in the group
  (task 6.2) — a non-member or denied-role holder gets redirected to a new
  `/access-denied` page (outside the `(app)` group on purpose, so it can't
  loop into its own redirect) instead of each route re-deriving the check.
  Task 6.3 ("re-verify on login") replaced the old `account.create.after`
  hook — which only ever fired once, at a user's very first sign-in ever —
  with `databaseHooks.session.create.after`, which fires on every login
  (first-time and returning alike); a Discord role change now takes effect
  next login instead of requiring an unlink/relink. Reads the Discord
  account's `accessToken` directly from the `accounts` table rather than via
  `auth.api.getAccessToken`, since this hook lives inside the same
  `betterAuth()` config that constructs `auth` (no clean self-reference) and
  the app doesn't configure OAuth token encryption, so the column already
  holds the same plaintext value that endpoint would return. `guilds.
  members.read` (task 6.1) needed no new work — already requested since
  Phase 5. Task 6.4 (officer privileges as a separate allow-list) was
  already true by construction (`users.role` stays admin-panel-driven,
  untouched here) — confirmed, not built.
  **Extended past the original task list, confirmed with the leader same
  day**: `isDeniedRole([])` now also denies — a member with zero Discord
  roles assigned at all, not just Orc Pawn/Guest by name. Discord's member
  endpoint omits the implicit `@everyone` role from its response, so `[]`
  means genuinely unassigned; Luna assigns roles by hand rather than
  on-join, so a brand-new member sits unassigned for a while by design and
  must be denied the same as Orc Pawn/Guest. This also fails closed if a
  role fetch never completed (Discord API hiccup, or a `users` row from
  before this column existed) — same call either way: no confirmed role on
  file, no access. One consequence: an already-signed-in user whose
  `discordRoleIds` is still `NULL` from before this deploy gets bounced to
  `/access-denied` on their very next page load, not just their next login —
  signing out and back in (the page's own button) re-runs the
  `session.create.after` hook and clears it.
  **Verified**: `isDeniedRole`/`parseDiscordRoleIds` against 9 hand-written
  cases (empty deny-list, single/multi-role match, empty-roles-denies with
  and without a configured deny-list, non-member, malformed JSON) via a
  throwaway script, deleted after; full `npm run build` + `tsc --noEmit`
  clean; `npm run verify` still 13/13 (unrelated code path, confirming no
  regression); `/access-denied` and `/characters` both smoke-
  tested against a real `wrangler dev --local` Miniflare run (unauthenticated
  requests redirect correctly, no runtime crash on either route — note
  `wrangler dev` serves `.open-next/`, which `npm run build` does NOT
  refresh; use `npx opennextjs-cloudflare build` or `npm run preview`
  first). **Not verified against a real Discord login** — same constraint as
  Phase 5's leader-only UI: this session has no Discord OAuth credentials to
  exercise an actual sign-in round trip, so the `session.create.after` hook
  itself (as opposed to the pure functions it calls) is unexercised live.
  Before deploying: `SEEKERS_DISCORD_DENIED_ROLE_IDS` needs the guild's real
  `Orc Pawn`/`Guest` role IDs set via `wrangler secret put` — right-click the
  role in Discord (Developer Mode on) -> Copy Role ID — local `.dev.vars` is
  left blank (denies nobody) since this session has no way to know them.
- **Phase 5 — global decay cutover, 2026-08-24**: `computeEpgpTotals`
  (`totals.ts`, task 5.2) now branches on the `decay_model` setting
  (already effective-dated since Phase 1 — task 5.1 turned out to be a
  no-op, just wiring up an existing column): `legacy` keeps deriving the
  flat, non-compounding 20% pre-cycle haircut exactly as before (§1a, never
  stored); `global` trusts raw ledger sums as-is, since 10%-compounding
  cycle decay is now applied as real stored negative rows at commit
  time — deriving anything on top would double-decay. `decay.ts`'s
  expansion-decay machinery generalized (task 5.3) into
  `previewRateDecay`/`commitRateDecay`/`findActiveRateDecayEvent`, taking a
  `RateDecayKind` (`"expansion" | "global_cycle"`) — the mechanics were
  already identical (rate × balance before `effectiveDate`, written as a
  linked negative ledger row); only the label (`"Decay"` vs. `"Cycle
  Decay"`) and `decay_events.kind` differ.
  `POST /api/officer/decay/commit` gained a `kind` field (defaults to
  `"expansion"` for any existing caller); preview and reverse needed no
  changes, since both were already kind-agnostic. Leader UI (task 5.4):
  `GlobalCycleDecayForm` mirrors `ExpansionDecayForm`'s rate → preview →
  confirm → commit shape (defaults to 10% per §1c's confirmed guild vote,
  adjustable), added as a new `/epgp/decay` section, sharing the existing
  preview action since preview math doesn't depend on kind.
  `scripts/verify-global-decay.ts` (`npm run verify:global-decay`, task
  5.5) runs 6 *real* `commitRateDecay(kind: "global_cycle")` batches
  against a snapshotted local D1 (snapshots first, restores in a `finally`
  regardless of outcome — safe to re-run against the live local DB) and
  confirms per-cycle and end-to-end 0.9ⁿ compounding on raw ledger balances
  for the top-10-EP players, every pre-cutover `ep_ledger`/`gp_ledger` row
  byte-identical before and after, and that flipping `decay_model` to
  `"global"` makes `computeEpgpTotals` report a tracked player's `ep`/`gp`
  as the raw ledger sum with `epDecay`/`gpDecay` both 0.
  **Running that test surfaced a real production bug, not a test
  artifact**: `decay.ts`'s own `ep_ledger`/`gp_ledger` inserts
  (`commitRateDecay` — both `expansion` and the new `global_cycle` — and
  `commitDepartureWipe`) never set `player_id`, only `character_id`.
  Harmless until Phase 3 task 3.11 repointed `computeEpgpTotals` to group
  by `player_id`; from that point on, every decay/departure commit became
  invisible to Roster and every totals-based view, even though the raw
  ledger math itself was correct throughout — `insertLedgerEntry` got this
  exact fix in the Phase 4 prerequisite commit, but `decay.ts` writes
  ledger rows directly via Drizzle and was missed. Fixed by threading
  `playerId` through `DecayPreviewRow`/`DeparturePreviewRow` (read once via
  `characters.player_id` in the preview step, no extra query at commit
  time) so every commit path sets it. **The 3 historical expansion-decay
  events were never affected** — they were backfilled by linking rows
  `scripts/import-epgp.ts` already wrote with `player_id` populated,
  never through this code path; confirmed directly (only 18 of 277
  decay-linked `ep_ledger` rows have a NULL `player_id`, and those are
  pre-existing orphaned rows, §1e, unrelated to this bug). Verified: `npm
  run verify` 13/13 (legacy-era numbers unmoved, task 5.6),
  `verify:expansion-decay` still 86% (unchanged baseline — the `playerId`
  addition to `previewRateDecay` is purely additive), `npm run build`
  clean. **Not verified in an actual browser** — `/epgp/decay` is
  leader-only behind Discord OAuth, which this session has no credentials
  for; the UI's logic was instead verified through the identical code path
  its server actions call directly (`commitRateDecay`/`previewRateDecay`),
  exercised live against local D1 by the new script above.
- **Phase 4 — attendance minimum, 2026-08-24**: `src/lib/epgp/attendance.ts`
  (`ATTENDANCE_GATED_ACTIVITIES` — Raid - Start/Mid/End, Event Attend only,
  an allowlist rather than an exemption denylist so anything else stays
  exempt by construction per §4h; `checkMinAttendance()`, effective-dated
  off `min_attendance` at the capture's own `occurredAt`, same pattern as
  the EP cap). `POST /api/officer/attendance` calls it before inserting
  anything (task 4.1) and rejects the whole batch with count/required/
  shortfall if short — headcount is the raw distinct-name count from the
  capture, not the post-resolution count, since attendance is about who was
  actually in the zone. Task 4.3's player-level dedupe: within one request,
  a name whose character resolves to a player_id already awarded in this
  submission is skipped and logged (`console.warn`, visible via
  `wrangler tail`) rather than silently dropped; a second DB check against
  existing `ep_ledger` rows for the same (player, activity, occurred_at)
  catches a duplicate resubmission of the same capture across two separate
  requests. Both kinds of skip come back in a new `duplicates` array
  alongside the existing `unmatched`, and the parser app surfaces both in
  its result message. `scripts/verify-attendance-minimum.ts` (task 4.5,
  `npm run verify:attendance-minimum`) replays every historical
  attendance-gated capture through the real `checkMinAttendance()` — **does
  not hard-assert §4h's "31" figure**, since that was a point-in-time count
  and the guild has kept raiding since (66 sub-12 captures as of this
  snapshot, still growing); instead asserts every group's accept/reject
  outcome agrees with an independent `count < 12` check, which is what
  actually catches a regression. Parser app (task 4.4):
  `AttendancePanel.tsx` fetches settings via the already-bound
  `FetchGuildSettings` on mount and again immediately before submit
  ("re-validate at submit," §4i) and blocks locally with "X of Y required"
  if the gated activity's row count is short — server-side stays
  authoritative regardless. `officerapi.AttendanceResponse` gained
  `Duplicates []string` (bindings regenerated via `wails generate module`).
  **4.2b (`Event Lead` inherits its event's validity) is not implemented**
  — see PLAN.md §16 for why (no reliable way to correlate a Manual Entry
  Event Lead award, submitted at "now," back to the raid capture it
  belongs to, without a schema or UI change).
  **Prerequisite fix found and made while starting this phase**:
  `insertLedgerEntry` (`src/lib/epgp/ledger-entry.ts`) had never actually
  been updated for Phase 3's schema — every new row (website form, officer
  manual-entry/attendance/bids) was writing `player_id`, `points_nominal`,
  `points_awarded`, `cap_applied`, `cap_at_entry` as NULL/default, despite
  the schema's own comments claiming otherwise. Harmless as long as nothing
  had actually written through it since the Phase 3.11 deploy (confirmed:
  local D1 had zero `manual`/`parse`-sourced rows), but every new
  attendance award in this phase would otherwise have landed with
  `player_id = NULL` and been invisible to `computeEpgpTotals` — the same
  fate as an orphaned row, just silent. Fixed to set `player_id` (an alt
  shares its player's `player_id` already, no extra query needed) and,
  for EP rows, `points_nominal = points_awarded = points` with
  `cap_applied = false` and `cap_at_entry` read live via `getSettingAt`.
  **Write-time cap *clamping* (the order-dependent per-cycle running sum,
  §2) is still not implemented** — deliberately: it depends on cycle
  management, which PLAN.md §16 lists as a still-open decision, so there's
  no correct cycle to sum against yet. Verified directly against local D1
  (not just `tsc`/`build`): a fresh `Event Attend` row for Khrathak came
  back with `player_id=49, points_nominal=50, points_awarded=50,
  cap_applied=0, cap_at_entry=900`, then deleted; confirmed Khrathak and
  his alt Tyvalus share `player_id=49` (what the dedupe logic depends on).
  Verify harness still 13/13, `npm run build` and `wails build` both clean.
- **Phase 3 tasks 3.7-3.12 — ledger schema, orphaned rows, status model,
  `computeEpgpTotals` repointed to `player_id`, 2026-08-24 (migrations
  0018-0019)**: `ep_ledger`/`gp_ledger` gain `player_id`, `points_nominal`,
  `points_awarded`, `cap_applied`, `cap_at_entry`, `orphaned`; `character_id`
  made nullable for orphaned rows. **Watch out**: `drizzle-kit generate`'s
  output for this migration was silently wrong — its `INSERT INTO
  __new_ep_ledger(...) SELECT ...` copied the brand-new columns from the OLD
  table too (which doesn't have them), and SQLite treated the unresolvable
  double-quoted column names as string literals instead of erroring
  (`"player_id"` landed as the literal text `player_id` in every row) rather
  than failing loud — caught only because a FK constraint happened to reject
  one of the garbage strings. **Any migration that adds columns AND rebuilds
  the same table in one `generate` call needs hand review before applying**:
  the INSERT/SELECT column lists should only include columns that existed on
  the old table; new columns get their default/NULL automatically, same as a
  plain `ALTER TABLE ADD COLUMN`. `scripts/import-epgp.ts` now populates
  `points_nominal` (sheet column T)/`points_awarded` (column V, was already
  `points`)/`cap_applied`/`cap_at_entry` (900, constant since Phase 1) on
  every emitted row directly — no separate backfill script, so a fresh
  production seed (Phase 14) gets this for free. It also now imports the
  1,637 orphaned EP rows (§1e) it previously silently skipped: turned out
  their "Points Earned" formula has no cached numeric result once the name's
  blank (not literally 0 — genuinely unresolvable), which is why the
  existing "missing date/activity/points" skip check was swallowing them
  before they ever reached the name check. `player_id` backfilled onto every
  ledger row via one correlated-subquery `UPDATE` per table (100% coverage,
  38,574 EP + 5,055 GP rows) — full local pipeline re-run (wipe + reimport +
  re-link decay events + backfill) to pick all of this up.
  `characters.status` enum renamed `retired`→`inactive` per §4j (zero data
  risk, no character had that status yet); `players`/`characters` both gain
  `status_changed_at` (+ `status_changed_by` on players). `computeEpgpTotals`
  (`src/lib/epgp/totals.ts`) now groups directly on
  `ep_ledger.player_id`/`gp_ledger.player_id` (no join — 3.9 already
  backfilled it) instead of `character_id`; `EpgpTotal.characterId` renamed
  to `playerId` (confirmed via search: no external code read that field, only
  the Map key mattered). All 4 consumers (`roster/page.tsx`,
  `api/officer/{bids,totals,characters}/route.ts`) and
  `scripts/verify-harness.ts` updated — each used to do its own manual
  alt→main resolution to work around character-keyed totals
  (`isAlt ? mainCharacterId : id`, with a `?? totals.get(r.id)` fallback);
  all replaced with a direct `totals.get(character.playerId)`, since every
  character sharing a player now reads the same total by construction.
  `insertLedgerEntry`'s alt→main character_id redirect at write time is now
  redundant but harmless, left alone. Verify harness 13/13 (one fixture
  added — see below); `npm run verify:expansion-decay` and `npm run build`
  both unaffected (decay.ts stays character-keyed on purpose, doc comment
  already explains why).
  **One legitimate fixture swap, not a bug**: Beguilez had been the
  `departed-gp-only` fixture (expected 75 GP, her own solo GP Log row), but
  Toryn's dump revealed she's a real alt of Khrathak alongside Valerion (100
  GP) — grouped by player, her total correctly becomes 140 (175 combined,
  20% pre-cycle decay). Confirmed by hand-tracing the arithmetic before
  touching anything. Swapped in Droctulft (identical 75-GP/no-decay profile,
  genuinely a single-character player) to keep that category testing what it
  always tested, and turned Beguilez's case into a new, real `main-alt-pair`
  fixture — resolving that category out of `DEFERRED_FIXTURES` with actual
  production data rather than an invented example.
  **New gap noticed, not fixed here** (documented in PLAN.md §16): characters
  created through the site's own flow (`characters/new`, claim approval)
  don't get `player_id` set — `computeEpgpTotals` excludes them safely
  (same as an orphaned row) rather than crashing, but their EP/GP wouldn't
  show up anywhere until claimed/linked. Likely Phase 10's problem to fix
  properly, since character claiming rework touches the same code path.
- **Phase 3 tasks 3.1/3.4-3.6 — Toryn's dump imported and derived into
  players/characters, 2026-08-23**: the real dump turned out to be a full
  `mysqldump` of `sos_bot`, not just `characters` — Toryn had started a
  separate, unfinished web-EPGP project against the same MySQL instance, so
  the export includes `members`/`ep_log`/`gp_log`/`bids`/`cycles`/`respawns`/
  etc. alongside `characters`. Only `characters` has real data (697 rows) and
  matters; everything else is empty/leftover schema, ignored entirely — see
  `data/imports/sos-bot/README.md`. Extended `scripts/import-sos-bot-dump.ts`
  with a dependency-free mysqldump parser (column order read from the file's
  own `CREATE TABLE`, then every `INSERT INTO ... VALUES` row) alongside the
  CSV path, so no manual conversion step is needed; also switched the D1
  write from batched inserts to one-row-at-a-time after local D1 (Miniflare)
  hit "too many SQL variables" well under SQLite's nominal 999-param limit
  even at small batch sizes (fine for a one-time/occasional import of a few
  hundred rows). New `scripts/derive-players-from-sos-bot.ts` (dry-run report
  by default, `--commit` to write; idempotent — reuses existing rows on
  re-run) implements tasks 3.4-3.6 together: builds one `players` row per
  `discord_id` group (216 of 243 groups had a clean single `main`-typed
  character → `main_character_id` set; the other 27 — 25 with zero mains, 2
  with multiple, a real data-quality gap in Toryn's bot — get
  `main_character_id` left NULL plus a `players.note` flagging it for leader
  review, **confirmed with the user rather than guessed**); creates a
  standalone `players` row for every one of the 86 existing `characters` the
  dump never mentions, so GP-only departed members stay attributable (§1e);
  and — **also confirmed with the user before writing anything** — creates a
  new `characters` row for each of the 525 dump characters (57 mains, 438
  alts, 30 mules) with no existing match at all, using the dump's own
  race/class/type/priority (race/class names resolved case-insensitively
  against `CHAR_RACES`/`CHAR_CLASSES`, unresolved values like the dump's
  literal `"None"` falling back to `UNKNOWN_RACE_ID`/`UNKNOWN_CLASS_ID`, same
  convention `scripts/import-epgp.ts` uses; `level` defaults to 1). Final
  state: 329 `players`, 783 `characters`, 100% linked. `tsc --noEmit` clean,
  harness still 12/12 (expected — totals aren't repointed to `player_id`
  until task 3.11, so this migration couldn't have moved them yet).
- **Phase 2 (expansion decay) complete**: `decay_events` table (migration
  0016) plus a nullable `decay_event_id` on `ep_ledger`/`gp_ledger`, so every
  row a decay batch writes traces back to (and can be deleted by) its event.
  `src/lib/epgp/decay.ts` owns the logic: `previewExpansionDecay` (read-only,
  rate × raw ledger balance as of the effective date — verified to the cent
  against the real 2025-12-30 event), `commitExpansionDecay` (one
  `decay_events` row + a linked negative ledger row per character with a
  positive balance; rejects a duplicate unreversed event on the same date),
  `reverseDecayEvent` (deletes the linked rows, marks the event reversed,
  writes a `ledger_audit_log` "delete" entry per row). Two consumers of the
  same functions: `/api/officer/decay/{preview,commit,reverse}`
  (`requireOfficerApiKey` + leader-only `canManageEpgpConfig` — decay is a
  leader call throughout PLAN.md §1b/§1c, a higher bar than the officer-level
  manual-entry/attendance/bids routes) and `/epgp/decay` (session-authed
  server actions) — the leader UI: rate + date → preview table → confirm →
  result, plus a decay-history list with a reverse button. Verified live
  against local D1 with a real minted officer key (preview math, duplicate
  rejection, reverse + re-commit, non-leader 403), not just tsc/build.
  `scripts/backfill-expansion-decay.ts` (`npm run backfill:expansion-decay`,
  idempotent) links the 3 historical "Decay" rows the sheet import already
  wrote to a new `decay_events` row each. `scripts/verify-expansion-decay.ts`
  (`npm run verify:expansion-decay`) checks the formula against the real
  2025-12-30 event — 86% of rows reproduce within a balance-scaled tolerance;
  the rest are two documented non-bug categories: leader's own "100% manual
  math" per §1b, and long-quiet GP-only characters the historical run
  excluded entirely (their retained GP wasn't decayed) — **resolved
  2026-08-22**, confirmed with the leader that going forward decay applies
  to every character equally regardless of guild status, no exceptions
  (§1f/§16); `previewExpansionDecay` already worked this way, no code
  change needed. Verify harness still 12/12 throughout.
- **Phase 2 addendum — inactivity EP wipe (§1f), same session**: a
  leader-requested tool, confirmed in the same conversation above. Zeros a
  selected set of characters' EP as a non-destructive `decay_events` row
  (`kind: 'departure'`, `ep_rate: 1`, `gp_rate: null`) — GP is never
  touched (§1e's asymmetry). `previewDepartureWipe`/`commitDepartureWipe`
  select by explicit character ids and/or "no EP-earning ledger row since
  date X"; reuses `reverseDecayEvent` as-is (already kind-agnostic).
  `POST /api/officer/decay/departure/{preview,commit}` (leader-only) plus a
  second section on `/epgp/decay` — search by name or inactivity cutoff →
  preview (current EP, last EP activity, GP shown but marked unaffected) →
  confirm → result. Verified live the same way as the expansion-decay
  routes (real minted officer key against local D1); DB restored
  afterward, harness 12/12.
- **Phase 0 (Foundations) complete**: `getCachedEpgpTotals` caching
  (0.1–0.4, see below); `scripts/import-epgp.ts` as the deterministic
  seed-from-xlsx tool (0.5); `scripts/snapshot.sh` save/restore (0.6);
  `scripts/golden-fixtures.ts`, a 12-character curated set covering every
  §5 edge case that's testable pre-Phase-3 (0.7); `scripts/verify-harness.ts`
  asserting `computeEpgpTotals()` against the sheet's cached numbers, 12/12
  passing (0.8) — **this is the regression suite for every later phase, run
  it (`npm run verify`) before and after any schema or totals-logic
  change.** See "Local-first testing" above for how these fit together.
- **Phase 1 (effective-dated settings) complete**: `epgp_settings` is now
  append-only history — `(id, setting_key, value, effective_from,
  changed_by, changed_at, note)`, migration 0015 — instead of one mutable
  row per key. `src/lib/epgp/settings.ts` owns reads/writes:
  `getSettingAt(key, date)` resolves the value in force at an arbitrary
  date (what makes the mutable EP cap in §2 and the decay-model cutover in
  §1c safe later); `getSettingsAt()` batches all keys "as of now" for
  `computeEpgpTotals`; `setSetting()`/`getSettingHistory()` back the new
  leader-only `/epgp/settings` UI (inline edit + expandable change log —
  the table itself is the audit trail) and `GET /api/officer/settings`.
  `scripts/import-epgp.ts` seeds baseline values idempotently (only fills a
  gap, never reverts a leader's later change) and now also seeds
  `min_attendance`/`decay_model`, new website-only settings not on the
  sheet. `seekers-epgp-parser` fetches settings at startup and via a
  Refresh button instead of hardcoding anything (task 1.6 — no hardcoded
  threshold existed yet to remove; this is the plumbing task 4.4 attaches
  its pre-submit check to). Verified end-to-end with a real minted API key
  against a locally-running site + the actual Go binary, not just unit
  tests. **Also fixed while testing this**: `scripts/snapshot.sh` restore
  could silently resurrect writes made after the snapshot — Miniflare's D1
  runs SQLite in WAL mode, and a plain `cp` left a stale `-wal` sidecar next
  to the restored file, which got replayed on next open. Fixed by
  checkpointing before save and dropping sidecars after restore.
- Core site: Discord auth + guild-membership gate, character CRUD/claim,
  PoP flag import/checklist, admin panel (roles, claims, import audit),
  Roster (merged EPGP standings, main/alt grouping), EPGP ledger with
  search/pagination/audit trail (`ledger_audit_log`).
- Officer API key system + all `/api/officer/*` routes listed above.
- `seekers-epgp-parser`: Attendance (capture + roster-linked review +
  submit), Bids (single-click capture via `send tells` detection,
  multi-winner Determine Winner, roster-driven review, submit), Manual
  Entry, Browse (read-only Ledger/Totals/Characters, sortable columns),
  Settings (API key, log file, link to `/epgp/app-key`). Unmatched
  Attendance/Bids rows resolve via `NoMatchSelect` — link to an existing
  character, attach as a new alt of a main, or add as a new main (see
  `POST /api/officer/characters` above).
- `seekers-epgp-parser` update check (2026-08-20): no installer, no
  silent auto-updater (Wails v2 has none built in) — instead an in-app
  startup banner. `main.Version` is embedded via `-ldflags` only on
  `vX.Y.Z` tag pushes, which also publish a GitHub Release with the
  `.exe` attached; `internal/updatecheck` compares the running build
  against that repo's `releases/latest` and prompts the officer to
  re-download if behind. See that repo's `CLAUDE.md` → "Releases &
  update checks" for the cut-a-release steps.
  **PLAN.md Phase 7 upgrades this** from notify-only into an actual
  download-and-swap, reusing the existing version/release plumbing.
- Nightly D1→R2 backup Worker (`workers/db-backup/`) — deployed, code
  works, **deliberately left unscheduled**. Decided 2026-08-20: D1's own
  Time Travel (point-in-time recovery, always-on, zero setup — 7 days on
  this account's Free plan) already covers the realistic risk here (bad
  data/a bug, not a Cloudflare-account-level disaster), so paying for
  Workers Paid or building free-tier Cron polling isn't worth it right
  now. Revisit only if the actual risk profile changes — see
  `workers/db-backup/README.md` for how to turn it on later.
- Parser app's selected log file now persists across restarts/rebuilds
  (`internal/config`), not just the API key.
- Fixed: `@better-auth/api-key`'s `keyExpiration.defaultExpiresIn` was set
  in milliseconds but the plugin reads it as seconds — keys were getting
  ~493-year expirations instead of the intended 180 days. Harmless
  direction (too-long, not too-short) and not the cause of the "key
  stopped working" issue — that one turned out to be separate; see below.
- **Fixed (root cause found, 2026-08-20): API key "stops working" within
  minutes was a rate limit, not expiration.** `@better-auth/api-key`
  defaults to 10 requests per 24-hour window when `rateLimit` is left
  unset in the plugin config, which this app never set. The parser app's
  Browse tab and roster lookups alone exceed 10 requests within minutes
  of normal clicking. A rate-limited `verifyApiKey` call comes back
  `{valid: false}` with no distinguishing info surfaced —
  `requireOfficerApiKey` (`src/lib/api-key-auth.ts`) collapsed that into
  the same "Invalid or expired API key" message used for an actually
  invalid/expired key, which is exactly what made this look like
  expiration. Fixed: `src/auth/index.ts` now sets an explicit
  `rateLimit: { timeWindow: 60_000, maxRequests: 120 }`, and
  `requireOfficerApiKey` surfaces the real error code/message instead of
  masking every failure the same way. **Existing keys need to be
  regenerated** — `rateLimitMax`/`rateLimitTimeWindow` are stored per-row
  at key-creation time, so the new default only applies to keys generated
  after this deployed.

**Explicitly deferred / open decisions:**
- `src/lib/epgp/tier.ts`'s `normalizeBidTier()` is unused — the shipped
  Bids flow uses a fixed dropdown, not free-text tier parsing. Leave it
  unless there's a reason to auto-resolve slang from raw tell text
  server-side.
- Gear tracking, pq-companion JSON import, per-class dashboards (original
  feasibility doc §9 Phase 2/3) — not started, not discussed recently.
- Remaining open questions live in `../PLAN.md` §16.
