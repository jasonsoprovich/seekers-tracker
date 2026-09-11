"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { reconcilePlayerMain } from "@/app/(app)/characters/[id]/account/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";

// Shown when the account's player pointer and the character rows disagree
// about which character is the main (see reconcilePlayerMain). Leaders get
// one button per candidate; everyone else sees the explanation.
export function ReconcileMainNotice({
  playerId,
  pointerMainName,
  typedMains,
  canFix,
}: {
  playerId: number;
  pointerMainName: string | null;
  typedMains: { id: number; name: string }[];
  canFix: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fix(c: { id: number; name: string }) {
    const ok = await confirm({
      title: `Make ${c.name} this account's main?`,
      message: "This repairs the records so the Roster and this page agree. Every other character on the account becomes an alt of it. No GP fee is charged and no swap is recorded.",
      confirmLabel: "Repair records",
    });
    if (!ok) return;
    setPending(c.id);
    setError(null);
    const result = await reconcilePlayerMain(playerId, c.id);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3 text-sm">
      <p className="font-medium text-amber-300">The records for this account disagree about its main.</p>
      <p className="mt-1 text-neutral-300">
        The account&apos;s main pointer says <strong>{pointerMainName ?? "nobody"}</strong>, but{" "}
        {typedMains.length === 1 ? (
          <>
            <strong>{typedMains[0].name}</strong> is typed as a main
          </>
        ) : (
          <>
            <strong>{typedMains.map((m) => m.name).join(", ")}</strong> are all typed as mains
          </>
        )}
        . The Roster groups by the character types, so it shows a different main than this page.
        {canFix ? " Pick the right one:" : " A leader or admin can repair it from this page."}
      </p>
      {canFix && (
        <div className="mt-3 flex flex-wrap gap-2">
          {typedMains.map((c) => (
            <Button key={c.id} type="button" size="sm" variant="outline" onClick={() => fix(c)} disabled={pending !== null}>
              {pending === c.id ? "Repairing…" : `${c.name} is the main`}
            </Button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
