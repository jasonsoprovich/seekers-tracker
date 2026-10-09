"use client";

import { useActionState } from "react";

import type { PqExportImportState } from "@/app/(app)/characters/[id]/import/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import { FileOrTextArea } from "@/components/FileOrTextArea";

type FlagRef = { id: string; label: string; zoneShort: string };

function FlagList({ flags, className }: { flags: FlagRef[]; className: string }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {flags.map((f) => (
        <li key={f.id} className={className}>
          [{f.zoneShort}] {f.label}
        </li>
      ))}
    </ul>
  );
}

export function ImportPqExportForm({
  action,
}: {
  action: (prevState: PqExportImportState, formData: FormData) => Promise<PqExportImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const preview = state.preview;
  const nothingToDo = preview && preview.toMarkDone.length === 0 && preview.toUnmark.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          pq-companion PoP flags export (.json)
          <FileOrTextArea
            name="json"
            rows={10}
            placeholder='{"kind": "pq-companion.popflags", "version": 1, "characters": [...]}'
            accept=".json"
            fileHint="a .json"
            className={fieldClasses({ mono: true })}
          />
        </label>

        {state.error && <p className="text-sm text-red-400">{state.error}</p>}

        {!state.result && (
          <Button type="submit" name="intent" value="preview" disabled={pending} className="self-start">
            {pending ? "Checking…" : "Preview import"}
          </Button>
        )}

        {preview && !state.result && (
          <Card className="flex flex-col gap-3 p-4">
            <p className="text-sm text-neutral-300">
              Changes for <strong>{preview.characterName}</strong>
              {preview.keptManual > 0 && ` — ${preview.keptManual} kept as manual overrides`}
              {preview.unknown > 0 && `, ${preview.unknown} unrecognized`}.
            </p>

            {preview.toMarkDone.length > 0 && (
              <div>
                <p className="text-sm font-medium text-emerald-400">Will be marked done ({preview.toMarkDone.length})</p>
                <FlagList flags={preview.toMarkDone} className="text-emerald-400" />
              </div>
            )}

            {preview.toUnmark.length > 0 && (
              <div className="rounded border border-amber-600/60 bg-amber-950/30 p-3">
                <p className="text-sm font-medium text-amber-300">
                  Warning: {preview.toUnmark.length} flag{preview.toUnmark.length === 1 ? "" : "s"} will be un-checked
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  pq-companion says these aren&apos;t done, but the site has them done. Flags you checked by hand
                  here are never changed. If this doesn&apos;t look right (wrong or old export?), don&apos;t
                  import.
                </p>
                <FlagList flags={preview.toUnmark} className="text-amber-300" />
                <label className="mt-3 flex items-center gap-2 text-sm text-neutral-200">
                  <input type="checkbox" name="confirmUnmark" />
                  Yes, un-check these {preview.toUnmark.length} flag{preview.toUnmark.length === 1 ? "" : "s"}
                </label>
              </div>
            )}

            {nothingToDo ? (
              <p className="text-sm text-neutral-400">Nothing to change — already up to date.</p>
            ) : (
              <>
                <input type="hidden" name="applyJson" value={preview.json} />
                <Button type="submit" name="intent" value="apply" disabled={pending} className="self-start">
                  {pending ? "Importing…" : "Apply import"}
                </Button>
              </>
            )}
          </Card>
        )}
      </form>

      {state.result && (
        <Card className="p-4">
          <p className="text-sm text-neutral-300">
            Imported for <strong>{state.result.characterName}</strong>: {state.result.markedDone.length} marked done,{" "}
            {state.result.unmarked.length} un-checked
            {state.result.keptManual > 0 && `, ${state.result.keptManual} kept as manual overrides`}
            {state.result.unknown > 0 && `, ${state.result.unknown} unrecognized`}.
          </p>
          <FlagList flags={state.result.markedDone} className="text-emerald-400" />
          <FlagList flags={state.result.unmarked} className="text-neutral-400" />
        </Card>
      )}
    </div>
  );
}
