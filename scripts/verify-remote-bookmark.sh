#!/usr/bin/env bash
# Phase 10.3/10.7: prove a restore records its current bookmark in the
# off-D1 registry before invoking Time Travel. Uses a fake Wrangler only.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fake="$tmp/wrangler"
calls="$tmp/calls.log"
registry="$tmp/remote.tsv"
local_log="$tmp/local.tsv"
target="00000001-00000002-00000003-00000004"
current="00000005-00000006-00000007-00000008"
printf '2026-09-13T00:00:00Z\t%s\tbefore test\n' "$target" > "$registry"

cat > "$fake" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_CALLS"
if [ "$1 $2 $3" = "d1 time-travel info" ]; then
  printf '{"bookmark":"%s"}\n' "$FAKE_CURRENT"
elif [ "$1 $2 $3" = "r2 object get" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--file" ]; then cp "$FAKE_REGISTRY" "$2"; break; fi
    shift
  done
elif [ "$1 $2 $3" = "r2 object put" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--file" ]; then cp "$2" "$FAKE_REGISTRY"; break; fi
    shift
  done
elif [ "$1 $2 $3" = "d1 time-travel restore" ]; then
  grep -q "$FAKE_CURRENT" "$FAKE_REGISTRY"
fi
EOF
chmod +x "$fake"

printf 'test-db\n' | WRANGLER_BIN="$fake" FAKE_CALLS="$calls" FAKE_REGISTRY="$registry" FAKE_CURRENT="$current" \
  RESTORE_DB_NAME="test-db" RESTORE_POINTS_LOG="$local_log" RESTORE_POINTS_REMOTE="test-bucket/restore-points.tsv" \
  scripts/remote-bookmark.sh restore "before test" >/dev/null

put_line="$(grep -n '^r2 object put ' "$calls" | cut -d: -f1)"
restore_line="$(grep -n '^d1 time-travel restore ' "$calls" | cut -d: -f1)"
if [ -z "$put_line" ] || [ -z "$restore_line" ] || [ "$put_line" -ge "$restore_line" ]; then
  echo "FAIL: restore ran before the pre-restore registry upload" >&2
  exit 1
fi
grep -q "$current" "$registry"
grep -q "automatic pre-restore before bookmark:$target" "$registry"
echo "Remote bookmark safety check passed."
