"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reinstateMember, removeMemberFromGuild } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Leader-only control in /admin's "Members & Roles" list. "Remove from
// guild" strips the person's site role to member, blocks all page access
// (players.status 'departed'), and zeroes their EP across every character
// (GP is kept). All three reverse on Reinstate — except the role, which a
// leader re-grants deliberately. See src/app/(app)/admin/actions.ts.
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
      message: `Remove ${username} from the guild? Their site role drops to member, they lose all site access, and their EP is zeroed on every character (GP is kept). Reinstating a leader restores the EP and access.`,
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
    const ok = await confirm({
      title: "Reinstate member",
      message: `Reinstate ${username}? Site access is restored and the EP that was zeroed on removal is added back (the removal decay batch is reversed). Their role is not restored — grant it separately if needed.`,
      confirmLabel: "Reinstate",
    });
    if (!ok) return;
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
