"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { rebuildStandingsAction } from "@/app/(app)/epgp/settings/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Leader-triggered full recompute of player_epgp_totals from the ledgers.
// Safe to run any time — it only rewrites the derived standings table, it
// never touches a ledger row. The usual reason to click it is right after a
// remote sheet-sync .sql apply, whose INSERTs bypass the normal
// refreshStandings write path.
export function RebuildStandingsButton() {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Rebuild standings?",
      message:
        "Recomputes every player's EP, GP and priority from the ledger rows. Doesn't change any ledger data — safe to run any time. Takes a few seconds.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    setMsg(null);
    const result = await rebuildStandingsAction();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMsg(`Rebuilt ${result.players ?? 0} players.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
        {pending ? "Rebuilding…" : "Rebuild standings"}
      </Button>
      {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
