"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { zeroRaidEpAction } from "@/app/(app)/epgp/raids/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Leader/admin: zero EP for this one event's attendance rows while KEEPING
// them — for an event that used the normal attendance-capture flow but
// genuinely has no EP tied to it (found out only after the fact, e.g. the
// 2026-09-27 "Moondust" event). Unlike ReverseRaidButton, nothing is
// deleted — GP/loot on the same date are untouched, and the prior point
// values survive in this ledger row's audit-log entry (viewable on
// /epgp/ledger's Audit tab) rather than a one-click undo.
export function ZeroRaidEpButton({ raidDate, raidName }: { raidDate: string; raidName: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Zero EP for this event?",
      message:
        `Sets every attendance row's EP on this event to 0 — the rows themselves (and who attended) stay exactly as recorded. ` +
        `GP and loot on the same date are untouched. This can't be undone with a button afterward — the previous value stays in ` +
        `each row's audit-log entry and would need to be restored by hand on /epgp/ledger if that's ever needed.`,
      confirmLabel: "Zero EP",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await zeroRaidEpAction(raidDate, raidName);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
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
        {pending ? "Zeroing…" : "Zero EP for this event"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
