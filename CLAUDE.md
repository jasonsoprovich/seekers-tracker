# Seekers of Souls — guild website + EPGP tooling

This is one half of a two-repo system. Read this whole file before making
changes — it's the thing that survives a cleared conversation.

**The two repos:**

| Repo | What it is | Where |
|---|---|---|
| `seekers-tracker` (this repo) | The website: Next.js app on Cloudflare Workers, D1, R2. Guild roster, character claiming, PoP flags, EPGP ledger/standings, admin panel. | `~/repos/github.com/jasonsoprovich/seekers-tracker` |
| `seekers-epgp-parser` | Standalone desktop app (Wails: Go backend + React/TS frontend) an officer runs locally. Parses their EverQuest log file for raid attendance and loot bids, then submits to this site over HTTP. | `~/repos/github.com/jasonsoprovich/seekers-epgp-parser` (sibling directory) |

They talk to each other over `/api/officer/*` routes on this site,
authenticated with an officer-issued API key (`x-api-key` header) instead
of a browser session — see "How the two repos connect" below. Both repos
get worked on in the same conversations; when you're deep in one, check
whether a change needs a matching change in the other.

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

## Workflow conventions (do these without being asked)

- **Commit after every major task/feature**, not just at the very end of
  a session — small scoped commits, not one giant one. Match the existing
  commit-message style: a one-line summary, then a body explaining *why*,
  not just what. Never mention Claude in commit messages by name beyond
  the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.
- **Migration order matters**: generate → apply `--local` → verify →
  apply `--remote` → *then* `npm run deploy`. Deploying code that expects
  a column/table before the remote migration exists will error in
  production.
- **After any change to `seekers-epgp-parser`**: `wails generate module`
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
- If something looks broken in production, reach for `npx wrangler tail
  seekers-tracker --format pretty` before guessing — it's what found both
  the OAuth-callback bug and confirmed the fix, live.

## How the two repos connect

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
- `docs/guild-website-feasibility.md` §9 task 20 / §10 describes an
  earlier plan (Cloudflare Cron pulling the guild's Google Sheet). **That
  was superseded by the parser-app + API-key architecture described
  here** — the sheet-sync plan was never built. Don't treat that section
  of the doc as current.

## Hard-won gotchas (don't rediscover these)

- **better-auth schema changes need their data backfilled, not just
  migrated.** Upgrading the `better-auth`/`@better-auth/*` version can add
  required columns (e.g. 1.7 added `accounts.issuer`, looked up as a
  compound `(issuer, accountId)` pair) that `drizzle-kit generate` will
  produce a migration for, but won't backfill existing rows — the
  generated SQL can even be syntactically broken (`ADD COLUMN ... NOT
  NULL` with no `DEFAULT` fails outright on a non-empty SQLite table).
  Read that version's upgrade guide for manual-preparation callouts before
  assuming `generate` + `apply` is suffient. This exact gap broke Discord
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

## Roadmap / status (update this section as things ship or change)

**Shipped:**
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
