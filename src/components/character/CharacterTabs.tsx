import Link from "next/link";

const TABS = [
  { key: "pop", label: "PoP Checklist", path: "" },
  { key: "gear", label: "Gear", path: "/gear" },
  { key: "stats", label: "Stats", path: "/stats" },
] as const;

export type CharacterTabKey = (typeof TABS)[number]["key"];

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
