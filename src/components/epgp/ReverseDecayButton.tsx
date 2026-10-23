"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reverseDecayAction } from "@/app/(app)/epgp/decay/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// reopensCycle: the cycle this decay started, if any — reversing removes it
// and reopens the cycle before it.
export function ReverseDecayButton({ decayEventId, label, reopensCycle = null }: { decayEventId: number; label: string; reopensCycle?: number | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Reverse decay?",
      message:
        `Reverse "${label}"? This deletes every ledger row it wrote.` +
        (reopensCycle !== null ? ` It also removes cycle #${reopensCycle} and reopens the previous cycle; EP recorded since then moves back into it.` : "") +
        " Can't be undone.",
      confirmLabel: "Reverse",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await reverseDecayAction(decayEventId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={onClick} disabled={pending} className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-60">
        {pending ? "Reversing…" : "Reverse"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
