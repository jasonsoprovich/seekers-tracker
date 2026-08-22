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
| `../seekers-bot` | Discord slash-command bot (Cloudflare Worker). **Not created yet — PLAN.md Phase 10.** |

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
`npm run import:epgp -- --file "/path/to/SoS - EPGP.xlsx" --wipe`). Parses
the guild's downloaded `.xlsx`, prints a reconciliation report against the
sheet's own cached `Totals` tab, and emits `drizzle/seed/epgp-import.sql`
(gitignored — regenerate, don't commit). Apply with
`npx wrangler d1 execute seekers-of-souls --local --file=drizzle/seed/epgp-import.sql`.
Deterministic and idempotent — safe to re-run after a fresh sheet export;
`--wipe` clears the EPGP ledger/config tables first (never touches
`characters`, which is `INSERT OR IGNORE` either way). This is also the
9/30 production-snapshot tool (PLAN.md §7).

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

**Current focus: PLAN.md §11 Phase 3 (players + ledger re-attribution) —
blocked on Toryn's MySQL dump (§14).** Phases 0, 1, and 2 are complete as of
2026-08-21, ahead of the 2026-09-30 expansion-decay deadline. Global decay
cutover deadline: 2026-10-17.

**Shipped:**
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
  the rest are two documented non-bug categories (leader's own "100% manual
  math" per §1b, and long-quiet GP-only characters the historical run
  excluded entirely — see the new §16 open question on whether the 9/30 run
  should do the same, since there's no departure-status field yet to
  reconstruct that exclusion). Verify harness still 12/12 throughout.
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
  **PLAN.md Phase 8 upgrades this** from notify-only into an actual
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
