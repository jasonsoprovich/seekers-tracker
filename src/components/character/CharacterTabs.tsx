import Link from "next/link";

// Gear and Stats (routes /gear, /stats) and the Quarmy import (/import) are
// still reachable by URL but are off the tab bar for now — the guild isn't
// using the Quarmy gear/stat sheets. Edit was a top-right link; it's a tab
// now, first, so the detail page reads Edit -> PoP Checklist.
const TABS = [
  { key: "edit", label: "Edit", path: "/edit" },
  { key: "pop", label: "PoP Checklist", path: "" },
] as const;

export type CharacterTabKey = (typeof TABS)[number]["key"] | "gear" | "stats";

export function CharacterTabs({ characterId, active }: { characterId: number; active: CharacterTabKey }) {
  return (
    <div className="mt-6 flex gap-1 border-b border-border text-sm font-medium">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={`/characters/${characterId}${tab.path}`}
          className={
            tab.key === active
              ? "border-b-2 border-accent px-3 py-2 text-neutral-100"
              : "border-b-2 border-transparent px-3 py-2 text-neutral-400 hover:text-neutral-200"
          }
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
