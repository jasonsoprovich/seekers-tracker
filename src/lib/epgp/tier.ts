// Normalizes free-text GP bid-tier spellings to the canonical activity names
// already seeded in epgp_point_values (see scripts/import-epgp.ts's
// POINT_VALUES) — "High Bid" / "Medium Bid" / "Low Bid". Case-insensitive,
// and covers the raid-chat shorthand/slang an officer confirmed guild
// members actually use ("major" for high, "slight" for medium), not just
// the literal tier names. Extend this list once we've seen real bid-log
// samples rather than guessing further variants ahead of time.
const TIER_SYNONYMS: Record<string, string> = {
  high: "High Bid",
  hi: "High Bid",
  major: "High Bid",
  medium: "Medium Bid",
  med: "Medium Bid",
  mid: "Medium Bid",
  slight: "Medium Bid",
  low: "Low Bid",
  lo: "Low Bid",
  minor: "Low Bid",
  small: "Low Bid",
};

// Returns the canonical tier name, or null if `raw` doesn't match any known
// spelling — callers must treat null as "needs manual review", not silently
// drop or guess.
export function normalizeBidTier(raw: string): string | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/\bbid\b/g, "")
    .trim();
  return TIER_SYNONYMS[key] ?? null;
}
