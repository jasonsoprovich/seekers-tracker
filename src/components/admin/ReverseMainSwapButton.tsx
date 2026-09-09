"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reverseMainSwapAction } from "@/app/(app)/admin/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// post-live-test-1 LT-30 — undo the most recent (un-reversed) main swap for
// a player: restores the previous main/alt grouping and refunds the exact
// GP fee that was charged (0 if it was waived). Leader/admin only.
export function ReverseMainSwapButton({
  eventId,
  prevMainName,
  newMainName,
  feeGp,
}: {
  eventId: number;
  prevMainName: string | null;
  newMainName: string;
  feeGp: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const feePart = feeGp > 0 ? ` Refunds the ${feeGp} GP fee to ${newMainName}.` : " No fee was charged.";
    const ok = await confirm({
      title: "Reverse this main swap?",
      message: `Restores ${prevMainName ?? "the previous main"} as the main and puts ${newMainName} back as an alt.${feePart}`,
      confirmLabel: "Reverse swap",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await reverseMainSwapAction(eventId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
      >
        {pending ? "Reversing…" : "Reverse last main swap"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
