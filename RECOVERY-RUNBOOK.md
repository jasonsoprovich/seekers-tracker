# Cloudflare Recovery Runbook

This is the operator procedure for recovering Seekers Tracker data. The main
application intentionally exposes status only. D1 Time Travel and portable SQL
restore remain command-line operations so an authenticated web session cannot
overwrite production.

## First Response

1. Stop new writes: ask officers to stop parser submissions and ask leaders not
   to edit EPGP, claims, characters, or settings until scope is understood.
2. Open `/admin/health`. Record dirty standings, last full rebuild, last
   portable backup, retention, and the newest named restore points.
3. Record the current code version from `/api/health` and the incident time in
   UTC.
4. Inspect Worker errors with `npx wrangler tail seekers-tracker --format pretty`.
5. Choose the narrowest recovery action below. Do not begin with Time Travel.

## Undo Ladder

1. Correct one ledger row through EPGP Ledger when the bad write is isolated.
2. Reverse one parser-recorded raid from that raid's Danger zone. This removes
   parsed EP/GP and that guild-local day's loot/bids in one D1 transaction.
3. Reverse one decay event from EPGP Decay. This removes every linked ledger
   row and marks the event reversed in one D1 transaction.
4. Rebuild standings from EPGP Settings when authoritative ledger rows are
   right but `/roster` is stale. Rebuild only derived tables.
5. Use D1 Time Travel only when the damage is broad or the bad mutation cannot
   be identified safely.
6. Use a portable R2 SQL export when the required point predates Time Travel or
   D1 itself is unavailable. Validate the dump against a scratch database
   before any production decision.

## D1 Time Travel

Time Travel is always enabled. This account's effective Paid window was
verified as 30 days on 2026-09-14 by resolving a bookmark ten days in the past.

Inspect only:

```bash
npx wrangler d1 time-travel info seekers-of-souls --json
npx wrangler d1 time-travel info seekers-of-souls --timestamp=2026-09-14T00:00:00Z --json
npm run bookmark -- list
```

Create a named point before risky work:

```bash
npm run bookmark -- mark "before incident recovery"
```

Restore by label, bookmark, or Unix timestamp:

```bash
npm run bookmark -- restore "before incident recovery"
```

The script requires typing `seekers-of-souls`. After confirmation it captures
the current bookmark and uploads an automatic pre-restore point to R2 before
Wrangler restore starts. A bookmark or R2 failure aborts the operation. Record
the undo bookmark Wrangler returns as another named point immediately.

After Time Travel:

1. Confirm `/api/health` and authenticated navigation.
2. Check migrations with `npx wrangler d1 migrations list seekers-of-souls --remote`.
3. Rebuild standings from EPGP Settings.
4. Compare ledger totals and the affected raid/decay/account records.
5. Resume parser submissions only after leadership accepts the result.

## Portable R2 Backups

Policy: daily at 09:00 UTC, retain 35 newest SQL exports in
`seekers-of-souls-db-backups`. The schedule and scoped `D1_REST_API_TOKEN`
were deployed on 2026-09-14. The first export and scratch restore still need
validation before the backup is considered operational.

One-time activation:

```bash
npx wrangler secret put D1_REST_API_TOKEN -c workers/db-backup/wrangler.jsonc
npx wrangler deploy -c workers/db-backup/wrangler.jsonc
npx wrangler workflows trigger seekers-db-backup -c workers/db-backup/wrangler.jsonc
npx wrangler workflows instances list seekers-db-backup -c workers/db-backup/wrangler.jsonc
```

The token should have only Account / D1 / Edit for this account. A D1 export
can temporarily block queries, so trigger the first run off-peak and watch the
site. A successful run updates `/admin/health` and writes a uniquely named SQL
object under `seekers-of-souls/`.

Scratch validation for an R2 object:

```bash
npx wrangler r2 object get seekers-of-souls-db-backups/<key> --remote --file backup.sql
npx tsx scripts/prepare-d1-export.ts backup.sql importable.sql
npx wrangler d1 execute seekers-recovery-drill --remote --file importable.sql
```

`seekers-recovery-drill` must be a disposable D1 database. Never use the
production database name for a validation import. Compare table counts and run
representative read-only queries before considering the dump usable.

## Safe Drill

Run after recovery-code changes:

```bash
npm run verify:recovery
```

The drill uses only local D1/R2, isolated temporary Miniflare state, API
fixtures, and a fake Wrangler restore. It proves:

- raid and decay reversals commit atomically and roll back on audit failure;
- a pre-restore bookmark is persisted before restore invocation;
- the current nested D1 export response is parsed correctly;
- System Health reads external metadata and records full rebuilds;
- a local D1 SQL export imports into a fresh isolated database.
- Cloudflare's interleaved export is reordered into a fresh-D1-safe file before
  import (all tables, then data, then indexes/views).

It never invokes `wrangler d1 time-travel restore` against Cloudflare.

## Drill Record

2026-09-14: Phase 10 drill passed locally. Read-only production checks
confirmed current and ten-day-old Time Travel bookmarks, 10,833,920-byte D1,
both expected R2 buckets, zero backup Workflow instances, and no backup API
token secret. The existing named restore-point registry was uploaded to R2.
No production restore, deployment, migration, parser release, or backup export
was performed.

2026-09-14 activation: the main application was deployed at Worker version
`a6cdafcc-872d-45ef-9496-eceb4fc07f94` (health build `83d0561`), and the
corrected backup Worker was deployed at version
`4d3883d3-e017-4b56-a33d-8ff1fc21cd2f`. The backup version exposes
`OPS_METADATA`, `KEEP_COUNT=35`, the daily Workflow schedule, and the scoped
secret. No Workflow instance or portable export existed immediately after
deployment; the first 09:00 UTC run remains to be validated. No migration or
production restore occurred.
