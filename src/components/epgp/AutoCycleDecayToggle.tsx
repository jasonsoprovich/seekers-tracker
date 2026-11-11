"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setAutoCycleDecayAction } from "@/app/(app)/epgp/decay/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export function AutoCycleDecayToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: on ? "Turn off automatic cycle decay?" : "Turn on automatic cycle decay?",
      message: on
        ? "Cycles will no longer end on their own. You'll need to run cycle decay below at each cycle end, and the reminder dot comes back."
        : "Cycle decay will run by itself at midnight Eastern at the end of each cycle's last day, using the rate of the last cycle decay.",
      confirmLabel: on ? "Turn off" : "Turn on",
      danger: on,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await setAutoCycleDecayAction(!on);
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
        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-neutral-800 disabled:opacity-60"
      >
        {pending ? "Saving…" : on ? "Turn off" : "Turn on"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
