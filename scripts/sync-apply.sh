#!/usr/bin/env bash
#
# Apply a sheet-sync .sql to production D1 and rebuild standings — the last
# two steps of Cloudflare Runbook §04, which are always done together and
# always in this order (a raw `wrangler d1 execute --remote --file` writes
# ledger rows without going through refreshStandings, so the materialized
# standings table is left stale until the rebuild runs).
#
#   1. npm run import:epgp -- --file "<sheet>.xlsx" --mode sync --remote
#   2. review drizzle/seed/epgp-sync.sql   <-- still do this by hand
#   3. npm run sync:apply                  <-- this script (steps 3 + 4)
#
# Usage:
#   SEEKERS_LEADER_API_KEY=<key> npm run sync:apply [path/to/file.sql]
#
# The key is a leader/admin app key from https://seekersofsouls.com/epgp/app-key
# (the /api/officer/standings/rebuild route is canManageEpgpConfig-gated).
set -euo pipefail

FILE="${1:-drizzle/seed/epgp-sync.sql}"
DB="seekers-of-souls"
REBUILD_URL="https://seekersofsouls.com/api/officer/standings/rebuild"

if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE not found — run 'npm run import:epgp -- --file <sheet>.xlsx --mode sync --remote' first" >&2
  exit 1
fi
if [[ -z "${SEEKERS_LEADER_API_KEY:-}" ]]; then
  echo "error: set SEEKERS_LEADER_API_KEY to a leader/admin app key (/epgp/app-key)" >&2
  exit 1
fi

echo "==> Applying $FILE to remote D1 ($DB)"
npx wrangler d1 execute "$DB" --remote --file "$FILE"

echo "==> Rebuilding standings on production"
curl -fsS -X POST "$REBUILD_URL" -H "x-api-key: $SEEKERS_LEADER_API_KEY"
echo
echo "==> Done. Spot-check /roster against the sheet."
