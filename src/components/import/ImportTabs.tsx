"use client";

import { useState, type ReactNode } from "react";

// Gear dropped 2026-09-04 — gear/stats came out of the character UI in
// 635df4e; this was the last place it was still reachable. The importGear
// server action and ImportGearForm are left in the tree (unreferenced),
// same as the /characters/[id]/gear route, in case gear tracking comes
// back.
const TABS = [
  { key: "pqc", label: "pq-companion" },
  { key: "seer", label: "Seer Text" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// Panels are toggled with the `hidden` attribute rather than conditional
// rendering — each import form keeps its result summary in useActionState,
// and unmounting on tab-switch would discard a just-completed import's
// result the moment the member looked at another tab.
export function ImportTabs({ pqc, seer }: { pqc: ReactNode; seer: ReactNode }) {
  const [active, setActive] = useState<TabKey>("pqc");
  const panels: Record<TabKey, ReactNode> = { pqc, seer };

  return (
    <div>
      <div className="flex gap-1 border-b border-border text-sm font-medium">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={
              tab.key === active
                ? "border-b-2 border-accent px-3 py-2 text-neutral-100"
                : "border-b-2 border-transparent px-3 py-2 text-neutral-400 hover:text-neutral-200"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
      {TABS.map((tab) => (
        <div key={tab.key} hidden={tab.key !== active} className="pt-6">
          {panels[tab.key]}
        </div>
      ))}
    </div>
  );
}
