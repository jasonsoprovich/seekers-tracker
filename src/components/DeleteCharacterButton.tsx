"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteCharacter } from "@/app/(app)/admin/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export function DeleteCharacterButton({ characterId, characterName }: { characterId: number; characterName: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirm({
      title: "Delete character?",
      message: `Delete ${characterName}? This removes their gear, PoP flags, EPGP, and import history. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    setError(null);
    const result = await deleteCharacter(characterId);
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
        className="text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
