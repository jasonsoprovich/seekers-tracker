// Shared by the dashboard page (server) and RosterOverview (client) — kept
// out of the client component so the server gets real values, not client
// references.
export const DASHBOARD_WINDOW_COOKIE = "dashboard_window";
export const DEFAULT_WINDOW = "14d";

const DAY = 86_400_000;
// The activity windows the dashboard offers; the spellbook grid's "Recently
// active" filter uses the same list so the two pages stay in step.
export const ACTIVITY_WINDOWS = [
  { value: "1d", label: "24h", ms: DAY },
  { value: "7d", label: "7 days", ms: 7 * DAY },
  { value: "14d", label: "14 days", ms: 14 * DAY },
  { value: "30d", label: "1 month", ms: 30 * DAY },
  { value: "365d", label: "1 year", ms: 365 * DAY },
  { value: "all", label: "All time", ms: Infinity },
] as const;
