// Historical placeholder used to record rot loot. It remains valid ledger
// history but is not a guild member and must never appear in roster views.
export function isRosterPlaceholder(name: string): boolean {
  return name.trim().toLowerCase() === "nolooter";
}
