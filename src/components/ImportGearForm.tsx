"use client";

import { useActionState } from "react";

import type { GearImportState } from "@/app/characters/[id]/import/actions";
import { FileOrTextArea } from "@/components/FileOrTextArea";

export function ImportGearForm({
  action,
}: {
  action: (prevState: GearImportState, formData: FormData) => Promise<GearImportState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Zeal Quarmy export (<code>&lt;CharName&gt;-Quarmy.txt</code>)
          <FileOrTextArea
            name="text"
            required
            rows={12}
            placeholder="Paste the full contents of the Quarmy.txt file here…"
            accept=".txt"
            fileHint="a .txt"
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
            {state.result.total} worn item{state.result.total === 1 ? "" : "s"} imported — replaces the previous
            gear list.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-neutral-400">
            {state.result.items.map((i) => (
              <li key={i.slot}>
                <span className="text-neutral-500">{i.slotLabel}:</span> {i.itemName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
