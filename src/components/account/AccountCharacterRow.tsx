"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPlayerMainCharacter } from "@/app/(app)/admin/actions";
import { detachCharacterFromAccount, setCharacterType } from "@/app/(app)/characters/[id]/account/actions";
import { Button } from "@/components/ui/Button";
import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fieldClasses } from "@/components/ui/Field";
import type { CharacterStatus } from "@/lib/character-status";

// Mirrors MAIN_SWAP_FEE_GP in src/lib/players.ts (client component — the
// server action is the source of truth for what's charged).
const MAIN_SWAP_FEE_GP = 500;

export type AccountCharacter = {
  id: number;
  name: string;
  level: number;
  className: string;
  raceName: string;
  charType: "main" | "alt" | "mule";
  status: CharacterStatus;
  isMain: boolean;
  lastActivity: string | null;
};

// One row of the account's character list. Which controls render is
// decided by the page from the viewer's role:
//   canRetype  — owner or officer+: alt <-> mule
//   canPromote — leader/admin: make this the main (500 GP, waivable)
//   canUnlink  — officer+: detach from the account
export function AccountCharacterRow({
  character,
  playerId,
  currentId,
  canRetype,
  canPromote,
  canUnlink,
}: {
  character: AccountCharacter;
  playerId: number;
  currentId: number;
  canRetype: boolean;
  canPromote: boolean;
  canUnlink: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [waive, setWaive] = useState(false);

  async function run(fn: () => Promise<{ error?: string }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function onRetype(type: "alt" | "mule") {
    if (type === character.charType) return;
    await run(() => setCharacterType(character.id, type));
  }

  async function onPromote() {
    const ok = await run(() => setPlayerMainCharacter(playerId, character.id, waive));
    if (ok) {
      setPromoting(false);
      setWaive(false);
    }
  }

  async function onUnlink() {
    const ok = await confirm({
      title: `Unlink ${character.name}?`,
      message: `${character.name} leaves this account and becomes an unclaimed character again. EP and GP already earned stay with this account.`,
      confirmLabel: "Unlink",
      danger: true,
    });
    if (!ok) return;
    await run(() => detachCharacterFromAccount(character.id));
  }

  const typeLabel = character.isMain ? "Main" : character.charType === "mule" ? "Mule" : "Alt";

  return (
    <li className={`px-4 py-3 ${character.id === currentId ? "bg-neutral-900/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <Link href={`/characters/${character.id}/account`} className="hover:text-emerald-300">
              {character.name}
            </Link>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
                character.isMain
                  ? "border-emerald-700 bg-emerald-950/40 text-emerald-400"
                  : "border-neutral-700 bg-neutral-900/60 text-neutral-400"
              }`}
            >
              {typeLabel}
            </span>
            <CharacterStatusBadge status={character.status} />
            {character.id === currentId && <span className="text-xs text-neutral-500">(this page)</span>}
          </p>
          <p className="text-sm text-neutral-400">
            Level {character.level} {character.className} — {character.raceName}
            {character.lastActivity && <span className="text-neutral-500"> · last active {character.lastActivity}</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!character.isMain && canRetype && (
            <select
              value={character.charType === "mule" ? "mule" : "alt"}
              onChange={(e) => void onRetype(e.target.value as "alt" | "mule")}
              disabled={pending}
              className={fieldClasses({ size: "sm" })}
              title="Alts count toward the account's EP/GP; mules are bank characters and never rank"
            >
              <option value="alt">Alt</option>
              <option value="mule">Mule</option>
            </select>
          )}
          {!character.isMain && canPromote && character.charType !== "mule" && !promoting && (
            <Button type="button" size="sm" variant="outline" onClick={() => setPromoting(true)} disabled={pending}>
              Make main…
            </Button>
          )}
          {!character.isMain && canUnlink && (
            <button
              type="button"
              onClick={onUnlink}
              disabled={pending}
              className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-60"
            >
              Unlink
            </button>
          )}
        </div>
      </div>

      {promoting && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-neutral-300">
          <span>
            Make <span className="font-medium text-neutral-100">{character.name}</span> this account&apos;s main? The current main
            becomes an alt; EP and GP stay with the account.
            {waive ? " No GP fee will be charged." : ` Charges ${MAIN_SWAP_FEE_GP} GP to ${character.name}.`}
          </span>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} disabled={pending} />
            Waive the {MAIN_SWAP_FEE_GP} GP fee
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPromoting(false);
                setWaive(false);
              }}
              disabled={pending}
              className="rounded border border-field px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-900/60 disabled:opacity-60"
            >
              Cancel
            </button>
            <Button type="button" onClick={onPromote} disabled={pending} size="sm">
              {pending ? "Swapping…" : waive ? "Swap (no fee)" : `Swap & charge ${MAIN_SWAP_FEE_GP} GP`}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </li>
  );
}
