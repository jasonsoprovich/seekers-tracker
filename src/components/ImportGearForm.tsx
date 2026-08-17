"use client";

import { useActionState } from "react";

import type { GearImportState } from "@/app/(app)/characters/[id]/import/actions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
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
        </Card>
      )}
    </div>
  );
}
