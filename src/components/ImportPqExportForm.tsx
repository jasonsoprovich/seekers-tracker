"use client";

import { useActionState } from "react";

import type { PqExportImportState } from "@/app/(app)/characters/[id]/import/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { FileOrTextArea } from "@/components/FileOrTextArea";

export function ImportPqExportForm({
  action,
}: {
  action: (prevState: PqExportImportState, formData: FormData) => Promise<PqExportImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          pq-companion &quot;Export Guild Progress&quot; JSON
          <FileOrTextArea
            name="json"
            required
            rows={10}
            placeholder='{"schema_version": 1, "character": {...}, "pop_flags": [...]}'
            accept=".json"
            fileHint="a .json"
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
            {state.result.total} flag{state.result.total === 1 ? "" : "s"} in export
            {" — "}
            {state.result.changed.length === 0 ? "nothing changed" : `${state.result.changed.length} changed`}
            {state.result.skippedManual > 0 && `, ${state.result.skippedManual} kept as manual overrides`}
            {state.result.skippedUnknown > 0 && `, ${state.result.skippedUnknown} unrecognized`}.
          </p>
          {state.result.changed.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {state.result.changed.map((f) => (
                <li key={f.id} className={f.done ? "text-emerald-400" : "text-neutral-400"}>
                  [{f.zoneShort}] {f.label} — {f.done ? "done" : "not done"}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
