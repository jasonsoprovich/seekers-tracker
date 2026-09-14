#!/usr/bin/env bash
# Phase 10.8 safe operator drill. Every destructive data-path check targets
# local snapshots or isolated temporary Miniflare state.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run verify:reversals
npm run verify:bookmark
npm run verify:backup-export
npm run verify:system-health
npm --prefix workers/db-backup run typecheck

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npx wrangler d1 export seekers-of-souls --local --output "$tmp/backup.sql"
npx tsx scripts/prepare-d1-export.ts "$tmp/backup.sql" "$tmp/importable.sql"
npx wrangler d1 execute seekers-of-souls --local --persist-to "$tmp/fresh-state" --file "$tmp/importable.sql" >/dev/null
result="$(npx wrangler d1 execute seekers-of-souls --local --persist-to "$tmp/fresh-state" --command "SELECT count(*) AS count FROM characters" --json)"
node -e '
  const rows = JSON.parse(process.argv[1]);
  const count = Number(rows[0]?.results?.[0]?.count ?? 0);
  if (count <= 0) throw new Error("portable SQL drill restored no characters");
' "$result"

echo "Phase 10 recovery drill passed without restoring production."
