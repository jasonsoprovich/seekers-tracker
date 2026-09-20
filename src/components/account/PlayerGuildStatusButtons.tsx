"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reinstatePlayer, removePlayerFromGuild } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Officer/leader/admin by default ("members.remove", opened to officers
// 2026-09-19): remove this player from the guild (EP zeroed as a
// reversible departure event, GP kept, every account character removed, site
// access off) or reinstate them.
// Keyed by players.id so it works for accounts that never claimed a site
// login too. Rendered only when the viewer's account/page.tsx already
// checked "members.remove" — this component has no gate of its own.
export function PlayerGuildStatusButtons({
  playerId,
  displayName,
  status,
  characterCount,
}: {
  playerId: number;
  displayName: string;
  status: "active" | "inactive" | "departed";
  characterCount: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ error?: string }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function onRemove() {
    const ok = await confirm({
      title: `Remove ${displayName} from the guild?`,
      message: `Removes all ${characterCount} linked character${characterCount === 1 ? "" : "s"} from the roster, zeroes the account's EP as a departure entry, keeps GP and every character record, drops any site role and app keys, and blocks site access. Reversible from this page.`,
      confirmLabel: "Remove from guild",
      danger: true,
    });
    if (!ok) return;
    await run(() => removePlayerFromGuild(playerId));
  }

  async function onReinstate() {
    const ok = await confirm({
      title: `Reinstate ${displayName}?`,
      message: "Restores the EP and characters removed with this account, then re-opens site access. Separately removed alts or mules stay removed. A site role has to be re-granted separately on Admin.",
      confirmLabel: "Reinstate",
    });
    if (!ok) return;
    await run(() => reinstatePlayer(playerId));
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      {status === "departed" ? (
        <Button type="button" size="sm" variant="outline" onClick={onReinstate} disabled={pending}>
          {pending ? "Reinstating…" : "Reinstate to guild"}
        </Button>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          className="rounded-full border border-red-800 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-950/40 disabled:opacity-60"
        >
          {pending ? "Removing…" : "Remove from guild"}
        </button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
