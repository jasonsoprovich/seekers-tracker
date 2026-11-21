#!/usr/bin/env bash
# Regenerates src/data/spells-1-60.json — the level 1-60 spells behind the
# Spells tab's "All spells" view (personal tracking only; /spells and its
# officer grid stay on the fixed 61-65 list in spells-61-65.json) — from
# pq-companion's bundled quarm.db.
#
#   scripts/gen-spells-1-60.sh [path/to/quarm.db]
#
# Same filters and shape as scripts/gen-spells-61-65.sh: no disciplines, no
# not_player_spell rows, only spells with a teaching scroll, duplicate names
# collapse to the lowest id, 0-based class ids. A spell some class gets at
# 61-65 and another at 1-60 lands in both files with each file's classes, so
# a class never sees it twice.
set -euo pipefail

DB="${1:-../../pq-companion/backend/data/quarm.db}"
OUT="$(dirname "$0")/../src/data/spells-1-60.json"
[ -f "$DB" ] || { echo "quarm.db not found at $DB" >&2; exit 1; }

cols=""
where=""
for c in $(seq 1 15); do
  cols="$cols, s.classes$c AS c$((c - 1))"
  where="$where OR s.classes$c BETWEEN 1 AND 60"
done
where="${where# OR }"

sqlite3 -json "$DB" "
  SELECT s.id, s.name,
    (SELECT min(i.id) FROM items i WHERE i.scrolleffect = s.id) AS scroll
    $cols
  FROM spells_new s
  WHERE s.IsDiscipline = 0 AND s.not_player_spell = 0 AND s.name != ''
    AND ($where)
    AND EXISTS (SELECT 1 FROM items i WHERE i.scrolleffect = s.id)
  ORDER BY s.id
" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const byName = new Map();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (byName.has(key)) continue; // ORDER BY id: first one wins
    const classes = [];
    for (let c = 0; c < 15; c++) {
      const lvl = r["c" + c];
      if (lvl >= 1 && lvl <= 60) classes.push({ classId: c, level: lvl });
    }
    byName.set(key, { spellId: r.id, name: r.name, scrollItemId: r.scroll, classes });
  }
  const spells = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  // One spell per line: ~1,400 entries, kept compact.
  process.stdout.write("[\n" + spells.map((s) => JSON.stringify(s)).join(",\n") + "\n]\n");
' > "$OUT"

echo "wrote $(node -e 'console.log(require(process.argv[1]).length)' "$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")") spells to $OUT"
