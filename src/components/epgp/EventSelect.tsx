import { fieldClasses } from "@/components/ui/Field";

export type EventOption = { value: string; label: string };

// "date|name" <-> { raidDate, raidName }. The name is everything after the
// first "|", so a name containing "|" survives.
export function encodeEvent(raidDate: string | null | undefined, raidName: string | null | undefined): string {
  return raidDate ? `${raidDate}|${raidName ?? ""}` : "";
}

export function decodeEvent(value: string): { raidDate: string; raidName: string } {
  const i = value.indexOf("|");
  return i < 0 ? { raidDate: value, raidName: "" } : { raidDate: value.slice(0, i), raidName: value.slice(i + 1) };
}

// Optional link to an EXISTING event (same list as Raids & Events). Replaces
// free-typed date/name fields, which could quietly create a phantom event.
// A row's current link that isn't in the list (legacy data) stays selectable
// so opening an edit never drops it.
export function EventSelect({
  value,
  events,
  onChange,
  name,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  value: string;
  events: EventOption[];
  onChange?: (value: string) => void;
  name?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const known = value === "" || events.some((e) => e.value === value);
  return (
    <select
      name={name}
      value={onChange ? value : undefined}
      defaultValue={onChange ? undefined : value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      aria-label={ariaLabel}
      className={fieldClasses({ size })}
    >
      <option value="">— None —</option>
      {!known && <option value={value}>{value.replace("|", " — ")} (current)</option>}
      {events.map((e) => (
        <option key={e.value} value={e.value}>
          {e.label}
        </option>
      ))}
    </select>
  );
}
