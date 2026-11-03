"use client";

import { useActionState } from "react";

import type { PqCharacterPreview, PqExportImportState, PqSkipped } from "@/app/(app)/characters/[id]/import/actions";
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

function SkippedList({ skipped }: { skipped: PqSkipped[] }) {
  if (skipped.length === 0) return null;
  return (
    <p className="text-xs text-neutral-500">
      Skipped: {skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.
    </p>
  );
}

function hasChanges(p: PqCharacterPreview) {
  return p.toMarkDone.length > 0 || p.toUnmark.length > 0 || p.manualConflicts.length > 0;
}

// One character's section of the preview. Only the warning/conflict lists
// live here — the confirm and overwrite checkboxes are one each for the
// whole import, below all the characters.
function CharacterPreview({ p }: { p: PqCharacterPreview }) {
  if (!hasChanges(p)) {
    return (
      <p className="text-sm text-neutral-400">
        <strong className="text-neutral-200">{p.characterName}</strong> — already up to date
        {p.unknown > 0 && `, ${p.unknown} unrecognized`}.
      </p>
    );
  }
  return (
    <details open className="rounded border border-neutral-800 p-3">
      <summary className="cursor-pointer text-sm text-neutral-200">
        <strong>{p.characterName}</strong>
        <span className="text-neutral-400">
          {" "}
          — {p.toMarkDone.length} to mark done
          {p.toUnmark.length > 0 && `, ${p.toUnmark.length} to un-check`}
          {p.manualConflicts.length > 0 && `, ${p.manualConflicts.length} manual differ`}
          {p.unknown > 0 && `, ${p.unknown} unrecognized`}
        </span>
      </summary>

      {p.toMarkDone.length > 0 && <FlagList flags={p.toMarkDone} className="text-emerald-400" />}

      {p.toUnmark.length > 0 && (
        <div className="mt-3 rounded border border-amber-600/60 bg-amber-950/30 p-3">
          <p className="text-sm font-medium text-amber-300">
            {p.toUnmark.length} flag{p.toUnmark.length === 1 ? "" : "s"} will be un-checked
          </p>
          <FlagList flags={p.toUnmark} className="text-amber-300" />
        </div>
      )}

      {p.manualConflicts.length > 0 && (
        <div className="mt-3 rounded border border-neutral-600 p-3">
          <p className="text-sm font-medium text-neutral-200">Set by hand, differ from pq-companion (kept unless you overwrite)</p>
          <ul className="mt-2 space-y-1 text-sm">
            {p.manualConflicts.map((f) => (
              <li key={f.id} className={f.exportDone ? "text-emerald-400" : "text-amber-300"}>
                [{f.zoneShort}] {f.label} — site: {f.exportDone ? "not done" : "done"} → pq-companion:{" "}
                {f.exportDone ? "done" : "not done"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

export function ImportPqExportForm({
  action,
}: {
  action: (prevState: PqExportImportState, formData: FormData) => Promise<PqExportImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const preview = state.preview;
  const totalUnmark = preview?.characters.reduce((n, p) => n + p.toUnmark.length, 0) ?? 0;
  const totalConflicts = preview?.characters.reduce((n, p) => n + p.manualConflicts.length, 0) ?? 0;
  const nothingToDo = preview && !preview.characters.some(hasChanges);

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
              {preview.characters.length === 1
                ? "Changes for 1 character."
                : `Changes for ${preview.characters.length} characters from this export.`}
            </p>

            {preview.characters.map((p) => (
              <CharacterPreview key={p.characterId} p={p} />
            ))}

            <SkippedList skipped={preview.skipped} />

            {totalUnmark > 0 && (
              <div className="rounded border border-amber-600/60 bg-amber-950/30 p-3">
                <p className="text-xs text-neutral-400">
                  pq-companion says the amber flags above aren&apos;t done, but the site has them done. Flags you
                  checked by hand here are never changed. If this doesn&apos;t look right (wrong or old export?),
                  don&apos;t import.
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm text-neutral-200">
                  <input type="checkbox" name="confirmUnmark" />
                  Yes, un-check these {totalUnmark} flag{totalUnmark === 1 ? "" : "s"}
                </label>
              </div>
            )}

            {totalConflicts > 0 && (
              <label className="flex items-center gap-2 text-sm text-neutral-200">
                <input type="checkbox" name="overwriteManual" />
                Overwrite manual settings with pq-companion&apos;s ({totalConflicts} flag{totalConflicts === 1 ? "" : "s"})
              </label>
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
        <Card className="flex flex-col gap-4 p-4">
          {state.result.characters.map((r) => (
            <div key={r.characterName}>
              <p className="text-sm text-neutral-300">
                Imported for <strong>{r.characterName}</strong>: {r.markedDone.length} marked done, {r.unmarked.length}{" "}
                un-checked
                {r.overwroteManual > 0 && ` (${r.overwroteManual} of them overwrote manual settings)`}
                {r.keptManual > 0 && `, ${r.keptManual} kept as manual overrides`}
                {r.unknown > 0 && `, ${r.unknown} unrecognized`}.
              </p>
              <FlagList flags={r.markedDone} className="text-emerald-400" />
              <FlagList flags={r.unmarked} className="text-neutral-400" />
            </div>
          ))}
          <SkippedList skipped={state.result.skipped} />
        </Card>
      )}
    </div>
  );
}
