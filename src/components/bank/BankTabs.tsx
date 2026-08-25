"use client";

import { useState } from "react";

import { BankBrowseTable } from "@/components/bank/BankBrowseTable";
import { SkyBankSection } from "@/components/bank/SkyBankSection";
import type { BankHoldingRow } from "@/lib/bank/holdings";
import type { SkyBankRewardRow, SkyBankStockRow } from "@/lib/quest-flags/list";

const TABS = [
  { key: "holdings", label: "Guild Bank" },
  { key: "sky", label: "Sky Bank" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// Guild Bank (bank_holdings — items, spells, and currency, already
// distinguished by BankBrowseTable's own category filter) and Sky Bank
// (sky_bank_rewards/sky_bank_stock) merged onto one page, 2026-08-25. Kept
// as two tabs rather than forcing Sky Bank's rows into bank_holdings'
// shape: sky_bank_rewards/sky_bank_stock have no holder, container, slot,
// or status columns at all — a real schema difference, not just a display
// choice. Panels stay mounted (hidden attribute, not unmounted) so
// switching tabs doesn't discard BankBrowseTable's filter/sort state or
// SkyBankSection's search, matching ImportTabs' established pattern.
export function BankTabs({
  holdings,
  canManage,
  skyRewards,
  skyStock,
}: {
  holdings: BankHoldingRow[];
  canManage: boolean;
  skyRewards: SkyBankRewardRow[];
  skyStock: SkyBankStockRow[];
}) {
  const [active, setActive] = useState<TabKey>("holdings");

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border text-sm font-medium">
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
      <div hidden={active !== "holdings"}>
        <BankBrowseTable holdings={holdings} canManage={canManage} />
      </div>
      <div hidden={active !== "sky"}>
        <SkyBankSection rewards={skyRewards} stock={skyStock} />
      </div>
    </div>
  );
}
