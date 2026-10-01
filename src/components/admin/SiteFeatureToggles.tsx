"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setItemTooltipsAction } from "@/app/(app)/admin/actions";

export function SiteFeatureToggles({ itemTooltips }: { itemTooltips: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(itemTooltips);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    setPending(true);
    setError(null);
    const result = await setItemTooltipsAction(next);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOn(next);
    router.refresh();
  }

  return (
    <div className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-border bg-panel p-4">
      <div className="max-w-2xl">
        <h3 className="font-medium text-neutral-200">Item tooltips (PQDI)</h3>
        <p className="mt-1 text-sm text-neutral-400">
          Item names on Live Bids, Raids &amp; Events loot, Bids History, the ledger, the guild bank and Guild Information become links to
          pqdi.cc with a hover/tap tooltip. Turn this off to show plain text again — nothing is requested from PQDI while it&apos;s off.
        </p>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Item tooltips"
        disabled={pending}
        onClick={toggle}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-emerald-500" : "bg-neutral-700"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
      </button>
    </div>
  );
}
