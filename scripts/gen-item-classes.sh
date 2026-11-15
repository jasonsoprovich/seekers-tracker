#!/usr/bin/env bash
# Generates src/data/item-classes.json — item_id -> Quarm class bitmask, for
# /bank's class filter (2026-11-14). Same source and pattern as
# scripts/gen-item-nodrop.sh: pq-companion's bundled quarm.db.
#
# Only class-RESTRICTED items are written. Items usable by every class
# (classes = 32767 / 65535) and items with no class data at all (classes =
# 0: bags, notes, tradeskill materials) are left out, and a missing id reads
# as "usable by all classes" (src/lib/items/item-classes.ts). Bit N is the
# site's 0-based class id N (Warrior = bit 0 … Beastlord = bit 14); spell
# scrolls carry their caster classes, so spells/songs filter the same way.
#
# Usage (re-run whenever the quarm.db reference copy is refreshed):
#   ./scripts/gen-item-classes.sh [path/to/quarm.db]
set -euo pipefail

DB="${1:-../../pq-companion/backend/data/quarm.db}"
OUT="$(dirname "$0")/../src/data/item-classes.json"

if [ ! -f "$DB" ]; then
  echo "quarm.db not found at $DB — pass its path as the first argument." >&2
  exit 1
fi

WHERE="(classes & 32767) NOT IN (0, 32767)"
sqlite3 -readonly "$DB" \
  "SELECT '{' || group_concat('\"' || id || '\":' || (classes & 32767)) || '}' FROM (SELECT id, classes FROM items WHERE $WHERE ORDER BY id);" \
  > "$OUT"

COUNT=$(sqlite3 -readonly "$DB" "SELECT count(*) FROM items WHERE $WHERE;")
echo "Wrote $OUT ($COUNT class-restricted item IDs)."
