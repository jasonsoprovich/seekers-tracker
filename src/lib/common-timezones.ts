// A short curated list for the profile timezone picker — not the full
// ~400-zone IANA list, just the ones a US-based EverQuest guild's members
// actually need. The stored value is any valid IANA zone name regardless
// (validated in profile/actions.ts via Intl, not against this list), so
// nothing breaks if someone's actual zone isn't in this dropdown — this is
// just what's offered by default.
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern (America/New_York)" },
  { value: "America/Chicago", label: "Central (America/Chicago)" },
  { value: "America/Denver", label: "Mountain (America/Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (America/Los_Angeles)" },
  { value: "America/Anchorage", label: "Alaska (America/Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Pacific/Honolulu)" },
  { value: "Europe/London", label: "UK (Europe/London)" },
  { value: "Europe/Berlin", label: "Central Europe (Europe/Berlin)" },
  { value: "Australia/Sydney", label: "Sydney (Australia/Sydney)" },
];
