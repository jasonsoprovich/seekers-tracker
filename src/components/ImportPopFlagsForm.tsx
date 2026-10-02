"use client";

import { useActionState } from "react";

import type { PopFlagsImportState } from "@/app/(app)/characters/[id]/import/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { FileOrTextArea } from "@/components/FileOrTextArea";

export function ImportPopFlagsForm({
  action,
}: {
  action: (prevState: PopFlagsImportState, formData: FormData) => Promise<PopFlagsImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          #popflags output from your EverQuest log
          <FileOrTextArea
            name="text"
            required
            rows={12}
            placeholder={"[Thu Oct 02 20:15:03 2026] === Planes of Power Progression ===\n[Thu Oct 02 20:15:03 2026] Tier 1: Complete\n…"}
            accept=".txt"
            fileHint="a .txt"
            className={fieldClasses({ mono: true })}
          />
        </label>

        {state.error && <p className="text-sm text-red-400">{state.error}</p>}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Importing…" : "Import"}
        </Button>
      </form>

      {state.result && (
        <Card className="p-4">
          <p className="text-sm text-neutral-300">
            Read {state.result.sections.length} report{state.result.sections.length === 1 ? "" : "s"} (
            {state.result.sections.join(", ")}) — {state.result.detected} completed flag
            {state.result.detected === 1 ? "" : "s"} detected,{" "}
            {state.result.changed.length === 0 ? "nothing new" : `${state.result.changed.length} newly marked done`}
            {state.result.keptManual > 0 && `, ${state.result.keptManual} left as your manual setting`}.
          </p>
          {state.result.pendingMemories > 0 && (
            <p className="mt-2 text-sm text-amber-400">
              {state.result.pendingMemories} checklist memor{state.result.pendingMemories === 1 ? "y is" : "ies are"}{" "}
              pending — sit near Seer Mal Nae`Shi, say &quot;unlock memories&quot;, then run #popflags again.
            </p>
          )}
          {state.result.changed.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-emerald-400">
              {state.result.changed.map((f) => (
                <li key={f.id}>
                  [{f.zoneShort}] {f.label}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            Imports only ever add completed flags — nothing you&apos;ve already tracked is removed or reset.
          </p>
        </Card>
      )}
    </div>
  );
}
