#!/usr/bin/env bash
# On-demand named restore points for the REMOTE (production) D1 database,
# built on Cloudflare D1 Time Travel. The local equivalent is
# scripts/snapshot.sh; there is no file to copy on remote, so instead this
# records the current Time Travel *bookmark* — a stable pointer to "the
# database exactly as it is right now" — in a local log with a label you
# choose, and can restore to one later.
#
# Time Travel keeps 7 days of history on the Workers Free plan (30 on
# Paid), so a bookmark older than that window stops working. Mark a fresh
# one right before anything risky; don't rely on last week's.
#
# Usage:
#   scripts/remote-bookmark.sh mark "before monday raid test"
#   scripts/remote-bookmark.sh list
#   scripts/remote-bookmark.sh restore "before monday raid test"
#   scripts/remote-bookmark.sh restore 00000085-0000024c-00004c6d-8e61...
#   scripts/remote-bookmark.sh restore 1730000000        # a unix timestamp
#
# `restore` resolves the label to its bookmark (or takes a raw bookmark /
# unix timestamp), shows exactly what it will do, and makes you type the
# database name before it runs `wrangler d1 time-travel restore`. That
# restore is itself reversible — wrangler prints a "to undo" bookmark when
# it finishes — but marking one with `mark` right before you restore is the
# safe habit.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="seekers-of-souls"
LOG_FILE="data/restore-points.log"

current_bookmark() {
  local out bm
  out="$(npx wrangler d1 time-travel info "$DB_NAME" --json 2>/dev/null)" || true
  bm="$(printf '%s' "$out" | tr ',{}' '\n' | sed -n 's/.*"bookmark"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$bm" ]; then
    # Fall back to parsing the normal (non-JSON) output.
    out="$(npx wrangler d1 time-travel info "$DB_NAME" 2>/dev/null)" || true
    bm="$(printf '%s' "$out" | sed -n "s/.*bookmark is '\([^']*\)'.*/\1/p" | head -n1)"
  fi
  printf '%s' "$bm"
}

is_bookmark() {
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]+-[0-9a-fA-F]+-[0-9a-fA-F]+-[0-9a-fA-F]+$'
}
is_timestamp() {
  printf '%s' "$1" | grep -Eq '^[0-9]{9,10}$'
}

cmd="${1:-}"

case "$cmd" in
  mark)
    label="${2:-}"
    if [ -z "$label" ]; then echo "Usage: $0 mark \"a label for this point\"" >&2; exit 1; fi
    bm="$(current_bookmark)"
    if [ -z "$bm" ]; then
      echo "Couldn't read a bookmark back from wrangler. Are you logged in? Try: npx wrangler login" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$bm" "$label" >> "$LOG_FILE"
    echo "Marked '$label'"
    echo "  bookmark: $bm"
    echo "  restore later with:  $0 restore \"$label\""
    ;;

  list)
    if [ ! -s "$LOG_FILE" ]; then
      echo "No restore points marked yet — run: $0 mark \"some label\""
      exit 0
    fi
    printf '%-21s  %-54s  %s\n' "WHEN (UTC)" "BOOKMARK" "LABEL"
    while IFS=$'\t' read -r when bm label; do
      printf '%-21s  %-54s  %s\n' "$when" "$bm" "$label"
    done < "$LOG_FILE"
    ;;

  restore)
    target="${2:-}"
    if [ -z "$target" ]; then echo "Usage: $0 restore \"label\" | <bookmark> | <unix-timestamp>" >&2; exit 1; fi

    if is_bookmark "$target"; then
      mode="bookmark"; value="$target"
    elif is_timestamp "$target"; then
      mode="timestamp"; value="$target"
    else
      if [ ! -s "$LOG_FILE" ]; then
        echo "No restore points logged, and '$target' isn't a bookmark or unix timestamp." >&2
        exit 1
      fi
      # Most recent line whose label (3rd tab field) equals the target.
      value="$(awk -F'\t' -v l="$target" '$3 == l { bm = $2 } END { print bm }' "$LOG_FILE")"
      if [ -z "$value" ]; then
        echo "No marked restore point labelled '$target'. Known labels:" >&2
        cut -f3 "$LOG_FILE" | sort -u | sed 's/^/  /' >&2
        exit 1
      fi
      mode="bookmark"
    fi

    echo "About to restore the PRODUCTION database '$DB_NAME'."
    if [ "$mode" = "timestamp" ]; then
      echo "  to unix timestamp: $value"
    else
      echo "  to bookmark:       $value"
    fi
    echo "  Every change made to the database since that point will be discarded."
    echo "  (wrangler prints a bookmark afterward that undoes this restore.)"
    printf "Type the database name (%s) to confirm: " "$DB_NAME"
    read -r confirm
    if [ "$confirm" != "$DB_NAME" ]; then echo "Aborted."; exit 1; fi

    if [ "$mode" = "timestamp" ]; then
      npx wrangler d1 time-travel restore "$DB_NAME" --timestamp="$value"
    else
      npx wrangler d1 time-travel restore "$DB_NAME" --bookmark="$value"
    fi
    ;;

  *)
    echo "Usage: $0 {mark|list|restore} ..." >&2
    echo "  $0 mark \"before monday raid test\"" >&2
    echo "  $0 list" >&2
    echo "  $0 restore \"before monday raid test\"" >&2
    exit 1
    ;;
esac
