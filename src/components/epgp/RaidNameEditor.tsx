"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { updateRaidMeta } from "@/app/(app)/epgp/raids/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

// Officer-only inline name/note for a raid night. Shown read-only to
// everyone else by the parent page (this component isn't rendered).
export function RaidNameEditor({ raidDate, name, note }: { raidDate: string; name: string | null; note: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(name ?? "");
  const [noteVal, setNoteVal] = useState(note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await updateRaidMeta(raidDate, nameVal, noteVal);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold">{name || <span className="text-neutral-500">Unnamed raid</span>}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          {name ? "Rename" : "Name this raid"}
        </Button>
        {note && <span className="text-sm text-neutral-500">— {note}</span>}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-neutral-900/40 p-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Name</span>
        <input value={nameVal} onChange={(e) => setNameVal(e.target.value)} placeholder="e.g. 9/2 VT" className={fieldClasses({ size: "sm" })} />
      </label>
      <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
        <span className="text-neutral-400">Note (optional)</span>
        <input value={noteVal} onChange={(e) => setNoteVal(e.target.value)} className={fieldClasses({ size: "sm" })} />
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setEditing(false);
          setNameVal(name ?? "");
          setNoteVal(note ?? "");
          setError(null);
        }}
      >
        Cancel
      </Button>
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </form>
  );
}
