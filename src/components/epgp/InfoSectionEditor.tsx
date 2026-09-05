"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { updateInfoSectionAction } from "@/app/(app)/epgp/info/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";

// A free-text section on the Cycle/Rules info page. `canEdit` (officer+,
// checked server-side by the page and re-checked by the action itself) is
// the only thing that renders the Edit control at all — a member gets the
// same read-only paragraph everyone else on the site sees.
export function InfoSectionEditor({
  sectionKey,
  title,
  body,
  canEdit,
}: {
  sectionKey: string;
  title: string;
  body: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [titleVal, setTitleVal] = useState(title);
  const [bodyVal, setBodyVal] = useState(body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await updateInfoSectionAction(sectionKey, titleVal, bodyVal);
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
      <section className="rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {canEdit && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-300">{body || <span className="text-neutral-500">(nothing written yet)</span>}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-neutral-900/40 p-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Title</span>
          <input value={titleVal} onChange={(e) => setTitleVal(e.target.value)} className={fieldClasses({ size: "sm" })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Text</span>
          <textarea
            value={bodyVal}
            onChange={(e) => setBodyVal(e.target.value)}
            rows={5}
            className={`${fieldClasses({ size: "sm" })} resize-y font-sans`}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setTitleVal(title);
              setBodyVal(body);
              setError(null);
            }}
          >
            Cancel
          </Button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </form>
    </section>
  );
}
