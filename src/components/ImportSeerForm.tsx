"use client";

import { useActionState } from "react";

import type { SeerImportState } from "@/app/(app)/characters/[id]/import/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { FileOrTextArea } from "@/components/FileOrTextArea";

export function ImportSeerForm({
  action,
}: {
  action: (prevState: SeerImportState, formData: FormData) => Promise<SeerImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Seer &quot;guided meditation&quot; text
          <FileOrTextArea
            name="text"
            required
            rows={12}
            placeholder="Paste the Seer Mal Nae`Shi's reply here…"
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
            Detected {state.result.detected} completed flag{state.result.detected === 1 ? "" : "s"}
            {" — "}
            {state.result.changed.length === 0
              ? "nothing new."
              : `${state.result.changed.length} newly marked done.`}
          </p>
          {state.result.changed.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-emerald-400">
              {state.result.changed.map((f) => (
                <li key={f.id}>
                  [{f.zoneShort}] {f.label}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
