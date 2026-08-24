"use client";

import { useActionState, useState } from "react";

import type { CharacterFormState } from "@/app/(app)/characters/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { characters } from "@/db";
import { CHARACTER_STATUSES, characterStatusLabel } from "@/lib/character-status";
import { CHAR_CLASSES, CHAR_RACES, MAX_CHAR_LEVEL } from "@/lib/eq/enums";

type Character = Pick<
  typeof characters.$inferSelect,
  "name" | "class" | "race" | "level" | "charType" | "mainCharacterId" | "quarmyUrl" | "status"
>;

export interface MainCandidate {
  id: number;
  name: string;
  ownerUsername: string;
}

export function CharacterForm({
  action,
  character,
  mainCandidates = [],
  submitLabel,
}: {
  action: (prevState: CharacterFormState, formData: FormData) => Promise<CharacterFormState>;
  character?: Character;
  mainCandidates?: MainCandidate[];
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  // "mule" is a Phase 3 backfill-only type (PLAN.md §4c) — this form has no
  // UI for it, so a mule row edited here just shows neither radio checked
  // until the user picks main/alt, same as any other unset selection.
  const [charType, setCharType] = useState<"main" | "alt" | "mule">(character?.charType ?? "main");

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          name="name"
          defaultValue={character?.name}
          required
          maxLength={64}
          autoComplete="off"
          className={fieldClasses()}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Class
        <select name="class" defaultValue={character?.class ?? CHAR_CLASSES[0].id} className={fieldClasses()}>
          {CHAR_CLASSES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.abbr} — {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Race
        <select name="race" defaultValue={character?.race ?? CHAR_RACES[0].id} className={fieldClasses()}>
          {CHAR_RACES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Level
        <input
          name="level"
          type="number"
          min={1}
          max={MAX_CHAR_LEVEL}
          defaultValue={character?.level ?? 1}
          required
          className={fieldClasses()}
        />
      </label>

      <fieldset className="flex gap-6 text-sm">
        <legend className="mb-1">Type</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="charType"
            value="main"
            checked={charType === "main"}
            onChange={() => setCharType("main")}
          />
          Main
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="charType"
            value="alt"
            checked={charType === "alt"}
            onChange={() => setCharType("alt")}
          />
          Alt
        </label>
      </fieldset>

      {charType === "alt" && (
        <label className="flex flex-col gap-1 text-sm">
          Main character
          <select
            name="mainCharacterId"
            defaultValue={character?.mainCharacterId ?? ""}
            className={fieldClasses()}
          >
            <option value="">Not linked yet</option>
            {mainCandidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.ownerUsername})
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">Which main this alt belongs to, for guild record-keeping.</span>
        </label>
      )}

      {character && (
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select name="status" defaultValue={character.status} className={fieldClasses()}>
            {CHARACTER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {characterStatusLabel(s)}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            Inactive/removed characters drop off the guild-wide roster views by default — nothing is deleted.
          </span>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        Quarmy profile URL
        <input
          name="quarmyUrl"
          type="url"
          placeholder="https://quarmy.com/b/…"
          defaultValue={character?.quarmyUrl ?? ""}
          maxLength={300}
          className={fieldClasses()}
        />
        <span className="text-xs text-neutral-500">Optional — links out for full gear/stat detail.</span>
      </label>

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
