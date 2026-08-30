"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reinstateMember, removeMemberFromGuild } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Leader-only control in /admin's "Members & Roles" list. "Remove from
// guild" is a player-level state (players.status 'departed') — it strips
// the person's site role to member and blocks all page access until
// reinstated, independent of Discord membership. Character records and
// EP/GP history are untouched. See src/app/(app)/admin/actions.ts.
export function RemoveMemberButton({
  userId,
  username,
  departed,
  isSelf,
}: {
  userId: string;
  username: string;
  departed: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const ok = await confirm({
      title: "Remove from guild",
      message: `Remove ${username} from the guild? Their site role drops to member and they lose all access to the site until a leader reinstates them. Their characters and EP/GP history stay as-is.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await removeMemberFromGuild(userId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function reinstate() {
    setPending(true);
    setError(null);
    const result = await reinstateMember(userId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  if (departed) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded border border-red-500/40 px-1.5 py-0.5 text-xs font-medium text-red-400">
          Removed
        </span>
        <Button type="button" variant="outline" size="sm" onClick={reinstate} disabled={pending}>
          {pending ? "…" : "Reinstate"}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={pending || isSelf}
        title={isSelf ? "You can't remove yourself" : undefined}
        className="text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-40"
      >
        {pending ? "…" : "Remove from guild"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
