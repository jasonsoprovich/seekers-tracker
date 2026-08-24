# Toryn's `sos_bot.characters` dump

Drop the dump here (this directory is gitignored except this README — see
`.gitignore` — it contains Discord IDs for every guild member and must never
be committed). See PLAN.md §14 for the full context and Phase 3 tasks 3.1/
3.4-3.6.

**Toryn sends a full `mysqldump` schema dump, not a single CSV** — he had
started a separate, unfinished web-EPGP project against the same MySQL
instance, so the dump includes several other tables (`members`, `ep_log`,
`gp_log`, `bids`, `cycles`, `respawns`, ...) alongside `characters`. **Only
`characters` matters here** — everything else is empty or leftover schema
from that abandoned project and is ignored entirely. A real dump has looked
like `Dump<date>/sos_bot_characters.sql` plus one `.sql` file per table.

## Expected shape

The import script (`scripts/import-sos-bot-dump.ts`) reads either format:

- **A raw mysqldump `.sql` file** (pass the `characters` table's own file,
  e.g. `Dump20260823/sos_bot_characters.sql`) — parsed directly: column order
  is read from the file's own `CREATE TABLE `characters`` statement (not
  assumed fixed), then every `INSERT INTO `characters` VALUES ...` row.
  This is the preferred path — no manual conversion needed.
- **A CSV** with a header row, columns matching Toryn's schema:

| Column | Type | Notes |
|---|---|---|
| `discord_id` | text | Required. Groups main/alt/mule under one account. |
| `char_name` | text | Required. |
| `char_race` | text | Optional. |
| `char_class` | text | Optional. |
| `char_type` | text | `main` / `alt` / `mule` (any case — normalized to lowercase on import). |
| `char_priority` | integer | Display order (main 0, alt 1, mule 2). Optional. |
| `is_officer` | boolean (`0`/`1`, `true`/`false`) | **Unused** — officer status comes from Discord roles (§4b). Carried through verbatim, not read by any derivation step. |

`characters`'s own `char_level` column (present in the real dump, always
NULL so far) is read and ignored — not part of `sos_bot_staging`'s shape and
not needed; `characters.level` is authoritative from the guild sheet import.

## Import

```bash
npx tsx scripts/import-sos-bot-dump.ts --file "data/imports/sos-bot/Dump<date>/sos_bot_characters.sql"
```

Loads into the `sos_bot_staging` table (truncate + reload — safe to re-run
against a corrected dump). Never written directly into `players` /
`characters` — that's a separate, reviewable step:

```bash
npx tsx scripts/derive-players-from-sos-bot.ts             # dry run, prints a full report
npx tsx scripts/derive-players-from-sos-bot.ts --commit     # write players + backfill characters
```

Idempotent — safe to re-run after a corrected `sos_bot_staging` reload; it
reuses existing `players`/`characters` rows rather than duplicating them.

## What the derivation does (Phase 3 tasks 3.4-3.6)

- Every `sos_bot_staging` row not matching an existing `characters.name`
  (case-insensitive) gets a **new** `characters` row (race/class resolved
  against `CHAR_RACES`/`CHAR_CLASSES`, unrecognized values fall back to
  `UNKNOWN_RACE_ID`/`UNKNOWN_CLASS_ID`; `level` defaults to 1, unknown from
  this source).
- One `players` row per distinct `discord_id`. A group with exactly one
  `char_type='main'` row gets that character as `main_character_id`; a group
  with zero or 2+ mains (a real data-quality gap in Toryn's bot) gets
  `main_character_id` left NULL and a note flagging it for leader review —
  **never guessed**, per §14.
- Every existing `characters` row the dump never mentions ("sheet-only" —
  the guild sheet has 249 distinct GP-log names; Toryn's bot only knows
  characters someone registered with it) gets its own standalone `players`
  row with a NULL `discord_id`, so GP history stays attributable per §1e even
  with no known Discord account — claimable later via §10.

The dry run prints the full reconciliation report (counts + every ambiguous
group + every sheet-only character name) before anything is written.
