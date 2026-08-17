"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { syncEpgp } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";

export function SyncEpgpButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    setMessage(null);
    const { result, error } = await syncEpgp();
    setPending(false);
    if (error) {
      setError(error);
      return;
    }
    if (result) {
      setMessage(
        `Synced ${result.matched} character${result.matched === 1 ? "" : "s"}.` +
          (result.unmatched.length > 0 ? ` ${result.unmatched.length} sheet row(s) had no matching character.` : ""),
      );
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={pending}>
        {pending ? "Syncing…" : "Sync EPGP"}
      </Button>
      {message && <p className="max-w-xs text-right text-xs text-neutral-400">{message}</p>}
      {error && <p className="max-w-xs text-right text-xs text-red-400">{error}</p>}
    </div>
  );
}
