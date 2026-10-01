// Port of the officer app's items.normalize (seekers-epgp-parser/internal/
// items/items.go): lowercase, backtick and curly quotes -> ', collapsed
// whitespace. quarm.db mixes ` and ' for the same character, and people only
// ever type the apostrophe. Keep in sync with that Go function.
export function normalizeItemName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[`‘’]/g, "'")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}
