"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reverseRaidAction } from "@/app/(app)/epgp/raids/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Leader/admin: undo an entire raid night — every parsed attendance award,
// GP charge, loot event and bid on that date. Mirrors ReverseDecayButton.
// The case for it: a night was captured against stale test data, or the
// same raid was parsed/imported twice, and it needs a clean redo rather
// than being unpicked row by row.
export function ReverseRaidButton({ raidDate }: { raidDate: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Reverse this raid?",
      message: `Deletes every parsed attendance row, GP charge, loot event and bid dated ${raidDate}. Standings are recomputed afterward. Can't be undone — re-parse or re-import the night to restore it.`,
      confirmLabel: "Reverse raid",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await reverseRaidAction(raidDate);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.push("/epgp/raids");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
      >
        {pending ? "Reversing…" : "Reverse this raid"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
