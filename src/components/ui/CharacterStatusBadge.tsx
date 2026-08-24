import { characterStatusLabel, type CharacterStatus } from "@/lib/character-status";

const STYLES: Record<Exclude<CharacterStatus, "active">, string> = {
  inactive: "border-amber-700 bg-amber-950/40 text-amber-400",
  removed: "border-red-800 bg-red-950/40 text-red-400",
};

// Renders nothing for "active" — that's the expected default, so it stays
// visually quiet and only inactive/removed characters get flagged.
export function CharacterStatusBadge({ status, className = "" }: { status: CharacterStatus; className?: string }) {
  if (status === "active") return null;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${STYLES[status]} ${className}`}>
      {characterStatusLabel(status)}
    </span>
  );
}
