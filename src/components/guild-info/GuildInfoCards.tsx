"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  createCardAction,
  deleteCardAction,
  moveCardAction,
  setCardWidthAction,
  updateCardAction,
} from "@/app/(app)/guild-info/actions";
import { GuildMarkdown } from "@/components/guild-info/GuildMarkdown";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fieldClasses } from "@/components/ui/Field";

type Card = { id: number; title: string; body: string; width: "full" | "half" };

const CHEAT_SHEET = "**bold**  *italic*  ~~strike~~  # Heading  - list  1. numbered  > quote  `code`  [text](https://link)";

function CardEditor({
  initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: { title: string; body: string };
  submitLabel: string;
  onSave: (title: string, body: string) => Promise<{ error?: string }>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await onSave(title, body);
    setPending(false);
    if (result.error) setError(result.error);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required className={fieldClasses()} />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span>Text</span>
          <div className="flex gap-1 text-xs">
            {[false, true].map((p) => (
              <button
                key={String(p)}
                type="button"
                onClick={() => setPreview(p)}
                className={`rounded-md px-2 py-0.5 ${preview === p ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
              >
                {p ? "Preview" : "Write"}
              </button>
            ))}
          </div>
        </div>
        {preview ? (
          <div className="min-h-[8rem] rounded-md border border-field bg-neutral-900 p-3">
            {body.trim() ? <GuildMarkdown>{body}</GuildMarkdown> : <span className="text-neutral-500">Nothing to preview.</span>}
          </div>
        ) : (
          <textarea aria-label="Text" value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={20000} className={`${fieldClasses()} resize-y font-mono`} />
        )}
        <span className="text-xs text-neutral-500">Markdown, like Discord: {CHEAT_SHEET}. Raw HTML isn&apos;t rendered.</span>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function GuildInfoCards({ cards, canEdit }: { cards: Card[]; canEdit: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
    return result;
  }

  async function onDelete(card: Card) {
    const ok = await confirm({
      title: "Delete card?",
      message: `Delete "${card.title}"? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await run(() => deleteCardAction(card.id));
  }

  return (
    <div>
      {canEdit && editingId !== "new" && (
        <div className="mb-4">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditingId("new")}>
            + Add card
          </Button>
        </div>
      )}
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {canEdit && editingId === "new" && (
          <section className="rounded-lg border border-accent/40 bg-neutral-900/40 p-4 md:col-span-2">
            <CardEditor
              initial={{ title: "", body: "" }}
              submitLabel="Add card"
              onCancel={() => setEditingId(null)}
              onSave={async (title, body) => {
                const r = await run(() => createCardAction(title, body, "full"));
                if (!r.error) setEditingId(null);
                return r;
              }}
            />
          </section>
        )}

        {cards.map((card, i) => {
          const span = card.width === "full" ? "md:col-span-2" : "";
          if (canEdit && editingId === card.id) {
            return (
              <section key={card.id} className={`rounded-lg border border-accent/40 bg-neutral-900/40 p-4 ${span}`}>
                <CardEditor
                  initial={card}
                  submitLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onSave={async (title, body) => {
                    const r = await run(() => updateCardAction(card.id, title, body));
                    if (!r.error) setEditingId(null);
                    return r;
                  }}
                />
              </section>
            );
          }
          return (
            <section key={card.id} className={`rounded-lg border border-border p-4 ${span}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="text-base font-semibold">{card.title}</h2>
                {canEdit && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button type="button" size="sm" variant="outline" disabled={busy || i === 0} onClick={() => run(() => moveCardAction(card.id, "up"))} aria-label="Move up">
                      ↑
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy || i === cards.length - 1} onClick={() => run(() => moveCardAction(card.id, "down"))} aria-label="Move down">
                      ↓
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => run(() => setCardWidthAction(card.id, card.width === "full" ? "half" : "full"))}
                      title="Toggle card width"
                    >
                      {card.width === "full" ? "Full width" : "Half width"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(card.id)}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDelete(card)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-2">
                {card.body.trim() ? <GuildMarkdown>{card.body}</GuildMarkdown> : <span className="text-sm text-neutral-500">(nothing written yet)</span>}
              </div>
            </section>
          );
        })}
      </div>

      {cards.length === 0 && editingId !== "new" && (
        <p className="text-sm text-neutral-400">{canEdit ? "No cards yet — add your first card." : "Nothing here yet. Check back soon."}</p>
      )}
    </div>
  );
}
