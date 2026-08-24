export const CHARACTER_STATUSES = ["active", "inactive", "removed"] as const;

export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];

const LABELS: Record<CharacterStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  removed: "Removed",
};

export function characterStatusLabel(status: CharacterStatus): string {
  return LABELS[status];
}

export function isValidCharacterStatus(value: string): value is CharacterStatus {
  return (CHARACTER_STATUSES as readonly string[]).includes(value);
}
