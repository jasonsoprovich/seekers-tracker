# seekers-tracker-db-backup

Nightly D1 -> R2 database backups, as a disaster-recovery hedge — the old
Google Sheet had no backup story at all. Separate from the main
`seekers-tracker` Worker on purpose: see the comment at the top of
`wrangler.jsonc`.

D1 already has [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
(automatic point-in-time recovery) with zero setup. This Worker is an
*additional* hedge: real, portable, downloadable SQL dump files in R2,
kept as the last `KEEP_COUNT` (currently 35) daily snapshots.

## Status

- The updated Worker was deployed on 2026-09-14 with the scoped
  `D1_REST_API_TOKEN`, both R2 bindings, and 35-copy retention. The first
  scheduled Workflow completed at 09:00 UTC and its 20,696,361-byte SQL object
  was successfully restored into a disposable remote D1 database with zero
  foreign-key violations. The backup is operational.
- Verified 2026-09-14: production D1 is 10,833,920 bytes and a bookmark from
  2026-09-04 resolves, confirming the effective Paid 30-day Time Travel
  window. Current Cloudflare docs also make Workflows available on both Free
  and Paid plans, so the old "Paid required for scheduling" note was stale.
- Chosen cadence: one export daily at 09:00 UTC, retaining 35 copies. This is
  off-peak, gives five portable daily points beyond Time Travel, and at the
  current database size remains comfortably below R2's 10 GB-month Standard
  free allowance even when SQL text is several times larger than D1 storage.
- `wrangler.jsonc` contains that schedule and it is deployed. The first
  scheduled R2 object and scratch-D1 restore were validated on 2026-09-14.

## One-time setup: the API token

The D1 export API is a Cloudflare REST API, not something the D1 binding
itself can do — so this Worker needs a scoped API token, unlike the main
app which only ever uses D1/R2 *bindings*.

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
2. Custom token, permission: **Account → D1 → Edit**, scoped to this one
   account. Don't grant anything broader.
3. From this directory, run:
   ```
   npx wrangler secret put D1_REST_API_TOKEN
   ```
   and paste the token when prompted. The token value never needs to
   pass through anyone else's hands — this stores it directly as an
   encrypted Worker secret.

## Manually triggering a backup

To trigger an additional off-peak backup manually:

```
npx wrangler workflows trigger seekers-db-backup
```

Check progress with `npx wrangler workflows instances list seekers-db-backup`,
and the resulting dump lands in the `seekers-of-souls-db-backups` R2
bucket under `seekers-of-souls/<timestamp>-<workflow-instance>-<filename>`.

## Restoring from a backup

Two options depending on how far back you need to go:

- **Time Travel** (fast path, works even if this Worker never ran):
  ```
  npx wrangler d1 time-travel restore seekers-of-souls --timestamp=<unix-ts>
  ```
  from the main `seekers-tracker` repo root.
- **From an R2 dump** (further back, or if Time Travel's window has
  passed): download the `.sql` file from R2
  (`npx wrangler r2 object get seekers-of-souls-db-backups/<key> --file backup.sql`),
  prepare its interleaved table/data order with
  `npx tsx scripts/prepare-d1-export.ts backup.sql importable.sql`, then apply
  it to a disposable database first with
  `npx wrangler d1 execute seekers-recovery-drill --remote --file importable.sql`.
  Never paste a portable dump directly into production as a test. It is a
  full SQL script, not a scoped restore.
