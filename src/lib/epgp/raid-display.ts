// What to call an event in the UI when no officer has named it: its zones,
// joined, so the list never shows a bare dash for a real night. Display
// only — the stored name and the event's identity (eventName) are untouched.
export function raidDisplayName(name: string | null, zones: string[]): string | null {
  return name ?? (zones.length ? zones.join(" / ") : null);
}
