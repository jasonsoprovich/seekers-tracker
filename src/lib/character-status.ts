export const CHARACTER_STATUSES = ["active", "retired", "removed"] as const;

export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];

const LABELS: Record<CharacterStatus, string> = {
  active: "Active",
  retired: "Retired",
  removed: "Removed",
};

export function characterStatusLabel(status: CharacterStatus): string {
  return LABELS[status];
}

export function isValidCharacterStatus(value: string): value is CharacterStatus {
  return (CHARACTER_STATUSES as readonly string[]).includes(value);
}
