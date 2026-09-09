"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPlayerMainCharacter } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

// Mirrors MAIN_SWAP_FEE_GP in src/lib/players.ts — kept as a literal here so
// this client component doesn't import that server-only module graph. The
// server action is the source of truth for what actually gets charged.
const MAIN_SWAP_FEE_GP = 500;

export type MainCharacterOption = { id: number; name: string };

// Mirrors RoleSelect.tsx's shape (PLAN.md §11 Phase 10 task 10.3) — pick,
// then a Save button appears only once the selection actually changed.
// post-live-test-1 LT-30: Save opens a confirm step first — a main swap
// charges the new main MAIN_SWAP_FEE_GP (500) GP unless the leader ticks
// "Waive the fee".
export function MainCharacterSelect({
  playerId,
  options,
  currentMainCharacterId,
}: {
  playerId: number;
  options: MainCharacterOption[];
  currentMainCharacterId: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState<number | null>(currentMainCharacterId);
  const [confirming, setConfirming] = useState(false);
  const [waive, setWaive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = value !== currentMainCharacterId;
  const targetName = options.find((o) => o.id === value)?.name ?? "the selected character";

  function reset() {
    setConfirming(false);
    setWaive(false);
    setValue(currentMainCharacterId);
  }

  async function commit() {
    if (value === null) return;
    setPending(true);
    setError(null);
    const result = await setPlayerMainCharacter(playerId, value, waive);
    setPending(false);
    if (result.error) {
      setError(result.error);
      reset();
      return;
    }
    setConfirming(false);
    setWaive(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <select
          value={value ?? ""}
          onChange={(e) => setValue(e.target.value ? Number(e.target.value) : null)}
          disabled={pending || confirming}
          className={fieldClasses({ size: "sm" })}
        >
          {currentMainCharacterId === null && <option value="">(no main set)</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.id === currentMainCharacterId ? " (current main)" : ""}
            </option>
          ))}
        </select>
        {changed && !confirming && (
          <Button type="button" onClick={() => setConfirming(true)} size="sm">
            Swap…
          </Button>
        )}
      </div>

      {confirming && changed && (
        <div className="flex flex-col items-end gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-xs text-neutral-300">
          <span className="text-right">
            Make <span className="font-medium text-neutral-100">{targetName}</span> this player&apos;s main?
            {waive ? (
              <> No GP fee will be charged.</>
            ) : (
              <>
                {" "}
                Charges <span className="font-medium text-neutral-100">{MAIN_SWAP_FEE_GP} GP</span> to {targetName}.
              </>
            )}
          </span>
          <label className="flex items-center gap-1.5 self-end">
            <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} disabled={pending} />
            Waive the {MAIN_SWAP_FEE_GP} GP fee
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={pending}
              className="rounded border border-field px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-900/60 disabled:opacity-60"
            >
              Cancel
            </button>
            <Button type="button" onClick={commit} disabled={pending} size="sm">
              {pending ? "Swapping…" : waive ? "Swap (no fee)" : `Swap & charge ${MAIN_SWAP_FEE_GP} GP`}
            </Button>
          </div>
        </div>
      )}

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
