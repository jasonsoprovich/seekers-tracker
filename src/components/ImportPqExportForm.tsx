"use client";

import { useActionState } from "react";

import type { PqExportImportState } from "@/app/characters/[id]/import/actions";

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
          <textarea
            name="json"
            required
            rows={10}
            placeholder='{"schema_version": 1, "character": {...}, "pop_flags": [...]}'
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100 focus:border-emerald-500 focus:outline-none"
          />
        </label>

        {state.error && <p className="text-sm text-red-400">{state.error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center self-start rounded-full bg-emerald-500 px-6 py-3 font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </form>

      {state.result && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
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
        </div>
      )}
    </div>
  );
}
