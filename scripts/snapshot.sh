#!/usr/bin/env bash
# PLAN.md §5 / Phase 0 task 0.6 — instant snapshot/restore for the local D1
# sqlite file, so a destructive test (decay run, migration) can be undone in
# one `cp` instead of re-running the full xlsx seed. Complements
# scripts/import-epgp.ts (§5's other option: regenerate from scratch).
#
# Usage:
#   scripts/snapshot.sh save [name]      # default name: "default"
#   scripts/snapshot.sh restore [name]
#   scripts/snapshot.sh list
#
# Never point this at anything but the LOCAL Miniflare D1 file (PLAN.md §5)
# — there is no remote mode here on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."

D1_DIR=".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
SNAPSHOT_DIR="data/snapshots"

find_live_db() {
  find "$D1_DIR" -iname "*.sqlite" ! -name "metadata.sqlite" 2>/dev/null | head -n1
}

cmd="${1:-}"
name="${2:-default}"

case "$cmd" in
  save)
    live="$(find_live_db)"
    if [ -z "$live" ]; then
      echo "No local D1 database found under $D1_DIR — run 'npm run dev' (or apply a seed) at least once first." >&2
      exit 1
    fi
    mkdir -p "$SNAPSHOT_DIR"
    cp "$live" "$SNAPSHOT_DIR/$name.sqlite"
    echo "Saved snapshot '$name' from $live"
    ;;
  restore)
    snap="$SNAPSHOT_DIR/$name.sqlite"
    if [ ! -f "$snap" ]; then
      echo "No snapshot named '$name' at $snap" >&2
      echo "Available snapshots:" >&2
      ls "$SNAPSHOT_DIR" 2>/dev/null >&2 || echo "  (none)" >&2
      exit 1
    fi
    live="$(find_live_db)"
    if [ -z "$live" ]; then
      echo "No local D1 database currently exists to restore into — run 'npm run dev' once first so Miniflare creates the file, then restore." >&2
      exit 1
    fi
    cp "$snap" "$live"
    echo "Restored snapshot '$name' into $live"
    ;;
  list)
    mkdir -p "$SNAPSHOT_DIR"
    if [ -z "$(ls -A "$SNAPSHOT_DIR" 2>/dev/null)" ]; then
      echo "(no snapshots yet — run 'scripts/snapshot.sh save' to create one)"
    else
      ls -lh "$SNAPSHOT_DIR"
    fi
    ;;
  *)
    echo "Usage: $0 {save|restore|list} [name]" >&2
    exit 1
    ;;
esac
