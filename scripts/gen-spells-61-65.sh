#!/usr/bin/env bash
# Regenerates src/data/spells-61-65.json — the fixed level 61-65 spell list
# behind /spells and each character's Spells tab — from pq-companion's
# bundled quarm.db.
#
#   scripts/gen-spells-61-65.sh [path/to/quarm.db]
#
# Filters mirror pq-companion's GetSpellsByClass (backend/internal/db/
# queries.go): no disciplines, no not_player_spell rows, and only spells with
# a teaching scroll in the items table — a spell nobody can scribe would sit
# on every checklist as a permanent false "missing". Duplicate-name rows
# collapse to the lowest id that has a scroll. Class ids are the site's
# 0-based ones (quarm classesN = site class N-1, see src/lib/eq/enums.ts).
set -euo pipefail

DB="${1:-../../pq-companion/backend/data/quarm.db}"
OUT="$(dirname "$0")/../src/data/spells-61-65.json"
[ -f "$DB" ] || { echo "quarm.db not found at $DB" >&2; exit 1; }

cols=""
where=""
for c in $(seq 1 15); do
  cols="$cols, s.classes$c AS c$((c - 1))"
  where="$where OR s.classes$c BETWEEN 61 AND 65"
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
      if (lvl >= 61 && lvl <= 65) classes.push({ classId: c, level: lvl });
    }
    byName.set(key, { spellId: r.id, name: r.name, scrollItemId: r.scroll, classes });
  }
  const spells = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  process.stdout.write(JSON.stringify(spells, null, 1) + "\n");
' > "$OUT"

echo "wrote $(node -e 'console.log(require(process.argv[1]).length)' "$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")") spells to $OUT"
