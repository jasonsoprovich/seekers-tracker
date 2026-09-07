"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setAuditNote } from "@/app/(app)/epgp/ledger/actions";
import { Button } from "@/components/ui/Button";

// The one editable part of an audit row (officer/leader/admin only) — a
// free-text "why" for the edit/delete it records. The row's action /
// before / after are never editable; only this note is.
export function AuditNoteCell({
  auditId,
  note,
  updatedByName,
  updatedAt,
}: {
  auditId: number;
  note: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const res = await setAuditNote(auditId, value.trim());
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="max-w-[22rem]">
        {note ? (
          <p className="whitespace-pre-wrap text-neutral-300">{note}</p>
        ) : (
          <p className="text-neutral-600">No note</p>
        )}
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setValue(note ?? "");
              setEditing(true);
            }}
            className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
          >
            {note ? "Edit note" : "Add note"}
          </button>
          {note && updatedByName && (
            <span className="text-[11px] text-neutral-500">
              — {updatedByName}
              {updatedAt ? `, ${new Date(updatedAt).toLocaleDateString()}` : ""}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[22rem]">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="Explain this change…"
        className="w-full rounded-md border border-field bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 focus:border-emerald-500/60 focus:outline-none"
      />
      <div className="mt-1 flex items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(false);
            setValue(note ?? "");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
