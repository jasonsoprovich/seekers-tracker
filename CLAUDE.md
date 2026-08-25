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

**Current focus: PLAN.md §11 Phase 11 (quest flags) is COMPLETE as of
2026-08-24** — see below for the writeup. Phase 10 (character claiming
rework) is also complete, same date. Phase 9 (Discord bot,
`../seekers-bot`) tasks 9.1-9.4 are also done, only 9.5 (a leadership
decision, not code) open there — see that repo's own `CLAUDE.md`. Phases
0-6 are complete (4.2b deliberately not implemented — see below and PLAN.md
§16). Both hard deadlines so far (expansion decay 9/30, global decay
cutover 10/17) already met, by Phase 2 and Phase 5 respectively.

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

**Phase 8 (guild bank) in progress as of 2026-08-24** — 8.1 (migration), 8.3
(parser, `seekers-epgp-parser/internal/bankexport`), 8.5 (browse/search) and
8.6 (manual add/edit) done; only 8.2 (migrate the sheet's own Bank tabs) and
8.4 (the real import endpoint) still need real inputs this session doesn't
have — 8.2 needs the guild's downloaded `.xlsx` (same file
`scripts/import-epgp.ts` already knows how to read), 8.4 needs real mule
exports (`data/imports/bank/`). **8.5/8.6 shipped in commit `f420b79` but
weren't checked off in `PLAN.md`/recorded here at the time** — caught and
fixed while starting Phase 9, see `PLAN.md`'s own 8.5/8.6 entries for what
they cover.

**Shipped:**
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
  **Not yet applied to remote D1** — migration 0022 is local-only pending
  the same "confirm before touching production" gate every prior phase's
  remote migration has had. Manual add/edit for these flags (mirroring
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
