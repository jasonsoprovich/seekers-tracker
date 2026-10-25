// EQ account groups were removed 2026-10-25 (migration 0060): SharedBank
// slots are flagged per character now. Officer apps built before then still
// call this from the old group editor, so answer with a clear message
// instead of a 404.
const GONE = {
  error: "EQ account groups were removed. Update the officer app to flag Shared Bank slots per character.",
};

export function PUT() {
  return Response.json(GONE, { status: 410 });
}

export function DELETE() {
  return Response.json(GONE, { status: 410 });
}
