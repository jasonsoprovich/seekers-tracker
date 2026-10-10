// The comparison key for "is this the same item?" across the guild bank's
// two name sources. The old sheet's Spell Bank tab lists a spell by its
// bare name ("Breath of Tunare"), but a Zeal inventory export uses the
// in-game item name ("Spell: Breath of Tunare"). Without folding the prefix
// away, a sheet row never matched the real synced spell even when it sat
// in the exact same slot — found 2026-10-10, when Darkclaw's first real
// sync left 158 of his sheet rows "not found" (4 of 165 matched; 153 do
// with the prefix stripped). Pure, so both the sync (server) and the
// /bank verification panel (client) can share it.
export function normalizeBankItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(?:spell|song):\s*/, "");
}
