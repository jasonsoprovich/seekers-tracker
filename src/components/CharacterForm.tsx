"use client";

import { useActionState } from "react";

import type { CharacterFormState } from "@/app/(app)/characters/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { characters } from "@/db";
import { CHAR_CLASSES, CHAR_RACES, MAX_CHAR_LEVEL } from "@/lib/eq/enums";

type Character = Pick<typeof characters.$inferSelect, "name" | "class" | "race" | "level" | "charType">;

export function CharacterForm({
  action,
  character,
  submitLabel,
}: {
  action: (prevState: CharacterFormState, formData: FormData) => Promise<CharacterFormState>;
  character?: Character;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

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
            defaultChecked={(character?.charType ?? "main") === "main"}
          />
          Main
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="charType" value="alt" defaultChecked={character?.charType === "alt"} />
          Alt
        </label>
      </fieldset>

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
