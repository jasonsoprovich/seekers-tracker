# seekers-tracker-db-backup

Nightly D1 -> R2 database backups, as a disaster-recovery hedge — the old
Google Sheet had no backup story at all. Separate from the main
`seekers-tracker` Worker on purpose: see the comment at the top of
`wrangler.jsonc`.

D1 already has [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
(automatic point-in-time recovery — 7 days on the Free plan we're
currently on, 30 days on Workers Paid) with zero setup. This Worker is an
*additional* hedge: real, portable, downloadable SQL dump files in R2,
kept as the last `KEEP_COUNT` (currently 7) nightly snapshots.

## Status

- Deployed (`seekers-tracker-db-backup`), R2 bucket created
  (`seekers-of-souls-db-backups`).
- **Not scheduled yet.** Scheduled Workflows require a paid Workers plan;
  this account is on Free. Options, in order of recommendation:
  1. Upgrade to Workers Paid ($5/mo) — also extends D1 Time Travel from
     7 to 30 days as a side effect. Then uncomment the `"schedules"`
     line in `wrangler.jsonc` and redeploy.
  2. Ask for a rework as a plain scheduled Worker (Cron Triggers work on
     Free) instead of a Workflow — less battle-tested (manual retry/poll
     logic instead of a Workflow's built-in step retries), but free.
  3. Trigger backups manually for now (see below) and revisit later.

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

Once the token secret is set:

```
npx wrangler workflows trigger seekers-db-backup
```

Check progress with `npx wrangler workflows instances list seekers-db-backup`,
and the resulting dump lands in the `seekers-of-souls-db-backups` R2
bucket under `seekers-of-souls/<date>-<filename>.sql`.

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
  then apply it to a database with
  `npx wrangler d1 execute seekers-of-souls --remote --file backup.sql`.
  Test this against a scratch D1 database first if you're unsure — it's
  a full SQL script, not a scoped restore.
