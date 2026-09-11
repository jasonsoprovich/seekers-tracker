"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPlayerMainCharacter } from "@/app/(app)/admin/actions";
import { detachCharacterFromAccount, setCharacterOfficerTag, setCharacterType } from "@/app/(app)/characters/[id]/account/actions";
import { Button } from "@/components/ui/Button";
import { CharacterStatusBadge } from "@/components/ui/CharacterStatusBadge";
import { useConfirm, useConfirmWith } from "@/components/ui/ConfirmDialog";
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
  officerTagged: boolean;
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
  showOfficerTag,
  canToggleOfficerTag,
}: {
  character: AccountCharacter;
  playerId: number;
  currentId: number;
  canRetype: boolean;
  canPromote: boolean;
  canUnlink: boolean;
  // The account's site role is officer+ — show the in-game officer tag
  // state; officer+ viewers can toggle it on non-main characters. The main
  // always carries the account's role.
  showOfficerTag: boolean;
  canToggleOfficerTag: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const confirmWith = useConfirmWith();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Modal with a Cancel button (leader, 2026-09-10 — the old inline
  // confirm strip was easy to miss) and the fee waiver as a checkbox in
  // the same dialog.
  async function onPromote() {
    const { ok, checked: waive } = await confirmWith({
      title: `Make ${character.name} the main?`,
      message: `The current main becomes an alt; EP and GP stay with the account. Unless waived below, ${MAIN_SWAP_FEE_GP} GP is charged to ${character.name}. A leader can reverse this later from the swap history.`,
      confirmLabel: "Swap main",
      checkbox: { label: `Waive the ${MAIN_SWAP_FEE_GP} GP fee` },
    });
    if (!ok) return;
    await run(() => setPlayerMainCharacter(playerId, character.id, waive));
  }

  async function onToggleOfficerTag(tagged: boolean) {
    await run(() => setCharacterOfficerTag(character.id, tagged));
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
          {showOfficerTag &&
            (character.isMain ? (
              <span className="rounded border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-sky-400">
                Officer
              </span>
            ) : canToggleOfficerTag ? (
              <label className="flex items-center gap-1.5 text-xs text-neutral-300" title="Show this character with the account's officer role on the roster">
                <input
                  type="checkbox"
                  checked={character.officerTagged}
                  disabled={pending}
                  onChange={(e) => void onToggleOfficerTag(e.target.checked)}
                />
                Officer tag
              </label>
            ) : (
              character.officerTagged && (
                <span className="rounded border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-sky-400">
                  Officer
                </span>
              )
            ))}
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
          {!character.isMain && canPromote && character.charType !== "mule" && (
            <Button type="button" size="sm" variant="outline" onClick={onPromote} disabled={pending}>
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

      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </li>
  );
}
