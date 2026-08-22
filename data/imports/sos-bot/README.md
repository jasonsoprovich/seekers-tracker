# Toryn's `sos_bot.characters` dump

Drop the dump here as **`characters.csv`** (this directory is gitignored via
`data/imports/` in `.gitignore` — it contains Discord IDs for every guild
member and must never be committed). See PLAN.md §14 for the full context and
Phase 3 task 3.1.

## Expected shape

A CSV with a header row and these columns, matching Toryn's `SOS-Bot` MySQL
schema (`github.com/khandyman/SOS-Bot`):

| Column | Type | Notes |
|---|---|---|
| `discord_id` | text | Required. Groups main/alt/mule under one account. |
| `char_name` | text | Required. |
| `char_race` | text | Optional. |
| `char_class` | text | Optional. |
| `char_type` | text | `main` / `alt` / `mule`. Optional — falls back to `main`. |
| `char_priority` | integer | Display order (main 0, alt 1, mule 2). Optional. |
| `is_officer` | boolean (`0`/`1`, `true`/`false`) | **Unused** — officer status comes from Discord roles (§4b). Carried through verbatim, not read by any derivation step. |

If Toryn sends a `mysqldump` `.sql` file instead of CSV, export the
`characters` table to CSV first (e.g. `SELECT * FROM characters INTO OUTFILE`
or a one-off `mysql -e "SELECT ... " -B | sed 's/\t/,/g'`) — the import script
only reads CSV.

## Import

```bash
npx tsx scripts/import-sos-bot-dump.ts --file data/imports/sos-bot/characters.csv
```

Loads into the `sos_bot_staging` table (truncate + reload — safe to re-run
against a corrected dump). Never written directly into `players` /
`characters`; that derivation is a separate, reviewable step (Phase 3 tasks
3.4+), so a bad derivation can be redone without re-importing the dump.

## Expect gaps

The guild sheet has 249 distinct GP-log character names; Toryn's bot only
knows characters someone registered with it. Task 3.6 produces an explicit
unmatched-character report for manual reconciliation with the leader —
unmatched characters get a `players` row with a NULL `discord_id`, claimable
later via §10.
