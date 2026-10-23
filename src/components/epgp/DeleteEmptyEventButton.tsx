"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteEmptyEventAction } from "@/app/(app)/epgp/raids/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Officer+: remove an event that has nothing recorded under it (no
// attendance, loot, EP or GP) — only its name/note row exists. No ledger
// row is touched; the server refuses if anything is linked.
export function DeleteEmptyEventButton({ raidDate, raidName }: { raidDate: string; raidName: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Delete this empty event?",
      message: `Removes "${raidName ?? raidDate}" from Raids and Events History. It has no attendance, loot, EP or GP, so no one's standings change.`,
      confirmLabel: "Delete event",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await deleteEmptyEventAction(raidDate, raidName);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.push("/epgp/raids");
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete empty event"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
