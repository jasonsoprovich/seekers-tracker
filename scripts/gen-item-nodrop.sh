#!/usr/bin/env bash
# Generates src/data/item-nodrop.json — a sorted JSON array of item IDs
# that are NO DROP in the Quarm item database (PLAN.md §9, 2026-09-25
# officer feedback: "is it possible to display a red no drop flag...
# besides items that are marked as no drop in the quarm dump database").
#
# Sourced from the sibling pq-companion repo's bundled quarm.db, same
# source src/data/item-stats.json already uses (see that file's own
# header comment). Confirmed against pq-companion's own reader
# (backend/internal/db/queries.go's HideNoDrop filter, which the code
# comment there gets right): `items.nodrop = 0` means NO DROP; any other
# value (-1, 1, 255 all appear in the real data) is tradeable. This is the
# OPPOSITE of what this repo's own drizzle/migrations... no wait, this is
# a brand-new file — just don't assume nodrop=1 means no-drop, it doesn't.
#
# Usage (re-run whenever the quarm.db reference copy is refreshed):
#   ./scripts/gen-item-nodrop.sh [path/to/quarm.db]
set -euo pipefail

DB="${1:-../pq-companion/backend/data/quarm.db}"
OUT="$(dirname "$0")/../src/data/item-nodrop.json"

if [ ! -f "$DB" ]; then
  echo "quarm.db not found at $DB — pass its path as the first argument." >&2
  exit 1
fi

sqlite3 -readonly "$DB" \
  "SELECT '[' || group_concat(id) || ']' FROM (SELECT id FROM items WHERE nodrop = 0 ORDER BY id);" \
  > "$OUT"

COUNT=$(sqlite3 -readonly "$DB" "SELECT count(*) FROM items WHERE nodrop = 0;")
echo "Wrote $OUT ($COUNT NO DROP item IDs)."
