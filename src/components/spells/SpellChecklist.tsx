"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setCharacterSpell } from "@/app/(app)/characters/[id]/spells/actions";
import { ItemLink } from "@/components/items/ItemLink";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SPELL_LEVELS, type ClassSpell } from "@/lib/spells";

// A character's 61-65 class spells as checkboxes, one collapsible section
// per level (open while anything in it is missing). Optimistic like
// PopFlagChecklist: the dot flips immediately and rolls back on a failed
// save. Officer-hidden spells are left out for members; officers get them
// in a collapsed "Hidden by officers" section so they can still be set.

function SpellRow({
  spell,
  has,
  source,
  readOnly,
  onToggle,
}: {
  spell: ClassSpell;
  has: boolean;
  source?: string;
  readOnly: boolean;
  onToggle: (spell: ClassSpell) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-2">
      <button
        type="button"
        onClick={() => onToggle(spell)}
        disabled={readOnly}
        title={readOnly ? "You don't have permission to edit this character" : has ? "Mark missing" : "Mark scribed"}
        className={`shrink-0 text-base leading-none ${readOnly ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        {has ? <span className="text-emerald-400">●</span> : <span className="text-neutral-600">○</span>}
      </button>
      <span className={`min-w-0 flex-1 truncate text-sm ${has ? "text-neutral-500" : "text-neutral-100"}`}>
        <ItemLink name={spell.name} itemId={spell.scrollItemId} />
      </span>
      {has && source === "zeal" && (
        <span className="shrink-0 rounded border border-neutral-700 bg-neutral-800/60 px-1.5 py-0.5 text-[9px] tracking-wider text-neutral-400 uppercase">
          zeal
        </span>
      )}
    </div>
  );
}

export function SpellChecklist({
  characterId,
  spells,
  owned,
  hiddenIds,
  showHidden,
  readOnly,
}: {
  characterId: number;
  spells: ClassSpell[];
  // spellId -> source
  owned: Record<number, string>;
  hiddenIds: number[];
  showHidden: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [local, setLocal] = useState<Record<number, string>>(owned);
  const [error, setError] = useState<string | null>(null);
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);

  const visible = spells.filter((s) => !hidden.has(s.spellId));
  const hiddenSpells = spells.filter((s) => hidden.has(s.spellId));

  async function onToggle(spell: ClassSpell) {
    if (readOnly) return;
    const prior = local[spell.spellId];
    const has = prior === undefined;
    setError(null);
    setLocal((prev) => {
      const next = { ...prev };
      if (has) next[spell.spellId] = "manual";
      else delete next[spell.spellId];
      return next;
    });
    const result = await setCharacterSpell(characterId, spell.spellId, has).catch(() => ({
      error: "Couldn't save — check your connection and try again.",
    }));
    if (result.error) {
      setLocal((prev) => {
        const next = { ...prev };
        if (prior === undefined) delete next[spell.spellId];
        else next[spell.spellId] = prior;
        return next;
      });
      setError(result.error);
      return;
    }
    // Updates the page's progress card.
    startRefresh(() => router.refresh());
  }

  if (spells.length === 0) {
    return <p className="text-sm text-neutral-500">This class has no level 61–65 spells to track.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {SPELL_LEVELS.map((level) => {
        const list = visible.filter((s) => s.level === level);
        if (list.length === 0) return null;
        const done = list.filter((s) => local[s.spellId] !== undefined).length;
        const complete = done === list.length;
        return (
          <details
            key={level}
            open={!complete}
            className={`overflow-hidden rounded-lg border ${complete ? "border-emerald-700" : "border-neutral-800"} bg-neutral-900/40`}
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
              <span className={`flex-1 text-sm font-semibold ${complete ? "text-emerald-400" : "text-neutral-100"}`}>
                Level {level}
              </span>
              <div className="w-32 shrink-0">
                <ProgressBar done={done} total={list.length} />
              </div>
            </summary>
            {list.map((s) => (
              <SpellRow key={s.spellId} spell={s} has={local[s.spellId] !== undefined} source={local[s.spellId]} readOnly={readOnly} onToggle={onToggle} />
            ))}
          </details>
        );
      })}
      {showHidden && hiddenSpells.length > 0 && (
        <details className="overflow-hidden rounded-lg border border-dashed border-neutral-800 bg-neutral-900/20">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
            <span className="flex-1 text-sm text-neutral-400">Hidden by officers ({hiddenSpells.length})</span>
            <span className="text-[11px] text-neutral-500">Not counted — unhide from /spells</span>
          </summary>
          {hiddenSpells.map((s) => (
            <SpellRow key={s.spellId} spell={s} has={local[s.spellId] !== undefined} source={local[s.spellId]} readOnly={readOnly} onToggle={onToggle} />
          ))}
        </details>
      )}
    </div>
  );
}
