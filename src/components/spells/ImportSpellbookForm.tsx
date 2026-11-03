"use client";

import { useActionState } from "react";

import type { SpellbookImportState } from "@/app/(app)/characters/[id]/spells/actions";
import { FileOrTextArea } from "@/components/FileOrTextArea";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { fieldClasses } from "@/components/ui/Field";

// Preview-then-add, through one form: the Preview button sends
// intent=preview, the Add button intent=commit with the same text (the
// textarea keeps its value between submits).
export function ImportSpellbookForm({
  action,
  characterName,
}: {
  action: (prev: SpellbookImportState, formData: FormData) => Promise<SpellbookImportState>;
  characterName: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <p className="max-w-xl text-sm text-neutral-400">
        In game with Zeal, type <code className="text-neutral-200">/outputfile spellbook</code>, then upload{" "}
        <code className="text-neutral-200">{characterName}-Spellbook.txt</code> from your EverQuest folder (or paste its
        contents). Only adds spells — nothing you&apos;ve already checked is removed.
      </p>
      <FileOrTextArea
        name="text"
        required
        rows={6}
        placeholder={"Index\tSpellId\tLevel\tName\n1\t3296\t61\tFaith\n…"}
        accept=".txt"
        fileHint="a .txt"
        className={fieldClasses({ mono: true })}
      />

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      {state.preview && (
        <Card className="p-4">
          <p className="text-sm text-neutral-300">
            Read {state.preview.lineCount} spell{state.preview.lineCount === 1 ? "" : "s"} — {state.preview.matched} on this
            class&apos;s 61–65 list,{" "}
            {state.preview.toAdd.length === 0 ? "all already checked." : `${state.preview.toAdd.length} new:`}
          </p>
          {state.preview.toAdd.length > 0 && (
            <ul className="mt-2 columns-1 gap-4 text-sm text-emerald-400 sm:columns-2">
              {state.preview.toAdd.map((s) => (
                <li key={s.spellId}>
                  <span className="text-neutral-500 tabular-nums">{s.level}</span> {s.name}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {state.added !== undefined && (
        <p className="text-sm text-emerald-400">
          {state.added === 0 ? "Nothing new to add." : `Added ${state.added} spell${state.added === 1 ? "" : "s"}.`}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>
          {pending ? "Reading…" : "Preview"}
        </Button>
        {state.preview && state.preview.toAdd.length > 0 && (
          <Button type="submit" name="intent" value="commit" disabled={pending}>
            Add {state.preview.toAdd.length} spell{state.preview.toAdd.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>
    </form>
  );
}
