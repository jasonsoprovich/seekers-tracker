"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

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
import { normalizeGuildMarkdown, slugify } from "@/lib/guild-info-markdown";

type Card = { id: number; title: string; body: string; width: "full" | "half" };

type Edit = { value: string; start: number; end: number };

// Each toolbar action turns the textarea's (value, selection) into a new
// (value, selection) — pure, so the textarea stays a normal controlled input.
function wrap(v: string, s: number, e: number, before: string, after: string, placeholder: string): Edit {
  const sel = v.slice(s, e) || placeholder;
  return { value: v.slice(0, s) + before + sel + after + v.slice(e), start: s + before.length, end: s + before.length + sel.length };
}

function lineRange(v: string, s: number, e: number): [number, number] {
  const from = v.lastIndexOf("\n", s - 1) + 1;
  const nl = v.indexOf("\n", e);
  return [from, nl === -1 ? v.length : nl];
}

function mapLines(v: string, s: number, e: number, fn: (line: string, i: number) => string): Edit {
  const [from, to] = lineRange(v, s, e);
  const out = v.slice(from, to).split("\n").map(fn).join("\n");
  return { value: v.slice(0, from) + out + v.slice(to), start: from, end: from + out.length };
}

function insert(v: string, s: number, e: number, text: string): Edit {
  return { value: v.slice(0, s) + text + v.slice(e), start: s + text.length, end: s + text.length };
}

const TOOLS: { label: string; title: string; run: (v: string, s: number, e: number) => Edit; className?: string }[] = [
  { label: "B", title: "Bold (Ctrl/⌘+B)", className: "font-bold", run: (v, s, e) => wrap(v, s, e, "**", "**", "bold text") },
  { label: "I", title: "Italic (Ctrl/⌘+I)", className: "italic", run: (v, s, e) => wrap(v, s, e, "*", "*", "italic text") },
  { label: "H2", title: "Section heading", run: (v, s, e) => mapLines(v, s, e, (l) => `## ${l.replace(/^#{1,6}\s+/, "")}`) },
  { label: "H3", title: "Sub-heading", run: (v, s, e) => mapLines(v, s, e, (l) => `### ${l.replace(/^#{1,6}\s+/, "")}`) },
  { label: "• List", title: "Bulleted list", run: (v, s, e) => mapLines(v, s, e, (l) => (l.trim() ? `- ${l.replace(/^\s*(?:[-*•]\s+)?/, "")}` : l)) },
  { label: "1. List", title: "Numbered list", run: (v, s, e) => mapLines(v, s, e, (l, i) => (l.trim() ? `${i + 1}. ${l.replace(/^\s*(?:\d+[.)]\s+)?/, "")}` : l)) },
  { label: "→ Indent", title: "Indent (nest a list item)", run: (v, s, e) => mapLines(v, s, e, (l) => `  ${l}`) },
  { label: "← Outdent", title: "Outdent", run: (v, s, e) => mapLines(v, s, e, (l) => l.replace(/^ {1,2}/, "")) },
  { label: "❝ Callout", title: "Highlighted callout box", run: (v, s, e) => mapLines(v, s, e, (l) => (l.startsWith("> ") ? l : `> ${l}`)) },
  { label: "― Divider", title: "Horizontal rule", run: (v, s, e) => insert(v, s, e, "\n\n---\n\n") },
  { label: "↕ Space", title: "Extra blank space (each extra blank line adds a gap)", run: (v, s, e) => insert(v, s, e, "\n\n\n") },
  { label: "Link", title: "Link", run: (v, s, e) => wrap(v, s, e, "[", "](https://)", "link text") },
  { label: "Item", title: "EverQuest item — links to PQDI with a tooltip when enabled", run: (v, s, e) => wrap(v, s, e, "[[", "]]", "Item Name") },
];

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
  const [view, setView] = useState<"write" | "preview">("write");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  function apply(run: (v: string, s: number, e: number) => Edit) {
    const el = area.current;
    if (!el) return;
    const next = run(body, el.selectionStart, el.selectionEnd);
    setBody(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "b") {
      e.preventDefault();
      apply(TOOLS[0].run);
    } else if (e.key === "i") {
      e.preventDefault();
      apply(TOOLS[1].run);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await onSave(title, body);
    setPending(false);
    if (result.error) setError(result.error);
  }

  const looksLikeDiscord = /^[ \t]*[•·▪‣◦●]/m.test(body);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required className={fieldClasses()} />
      </label>

      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span>Text</span>
          {/* Write/Preview tabs only below lg — on wide screens both show side by side. */}
          <div className="flex gap-1 text-xs lg:hidden">
            {(["write", "preview"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-2 py-1 capitalize ${view === v ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className={`${view === "write" ? "flex" : "hidden"} min-w-0 flex-col gap-2 lg:flex`}>
            <div role="toolbar" aria-label="Formatting" className="flex gap-1 overflow-x-auto pb-1">
              {TOOLS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  title={t.title}
                  onClick={() => apply(t.run)}
                  className={`shrink-0 rounded-md border border-border px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 ${t.className ?? ""}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <textarea
              ref={area}
              aria-label="Text"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              rows={16}
              maxLength={20000}
              className={`${fieldClasses()} min-h-[16rem] resize-y font-mono`}
            />
            {looksLikeDiscord && (
              <button
                type="button"
                onClick={() => setBody(normalizeGuildMarkdown(body))}
                className="self-start rounded-md border border-border px-2 py-1 text-xs text-emerald-400 hover:bg-neutral-800"
                title="Rewrites Discord-style • bullets into plain list syntax (the page already renders them correctly either way)"
              >
                Tidy pasted Discord bullets
              </button>
            )}
          </div>
          <div className={`${view === "preview" ? "block" : "hidden"} min-w-0 lg:block`}>
            <div className="min-h-[16rem] rounded-md border border-field bg-neutral-900 p-3">
              {body.trim() ? <GuildMarkdown>{body}</GuildMarkdown> : <span className="text-neutral-500">Nothing to preview yet.</span>}
            </div>
          </div>
        </div>

        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer text-neutral-400">Formatting help</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <code>**bold**</code> <code>*italic*</code> <code>~~strike~~</code> <code>## Heading</code> <code>[text](https://link)</code>
            </li>
            <li>
              Start a line with <code>- </code> or <code>•</code> for a bullet; indent a line to nest it. <code>1. </code> makes a numbered list.
            </li>
            <li>One blank line starts a new paragraph. Each <em>extra</em> blank line adds visible space (the ↕ Space button).</li>
            <li>
              <code>&gt; text</code> makes a highlighted callout; <code>---</code> a divider.
            </li>
            <li>
              <code>[[Item Name]]</code> marks an EverQuest item — it links to PQDI with a hover tooltip when item tooltips are enabled.
            </li>
            <li>
              Link to another card on this page with <code>[Earning EP](#earning-ep)</code> — the part after # is the card title in lower case with dashes.
            </li>
            <li>Raw HTML isn&apos;t rendered.</li>
          </ul>
        </details>
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

type Direction = "up" | "down" | "top" | "bottom";

function CardActions({
  card,
  index,
  count,
  busy,
  run,
  onEdit,
  onDelete,
}: {
  card: Card;
  index: number;
  count: number;
  busy: boolean;
  run: (fn: () => Promise<{ error?: string }>) => Promise<unknown>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const move = (d: Direction) => run(() => moveCardAction(card.id, d));
  const toggleWidth = () => run(() => setCardWidthAction(card.id, card.width === "full" ? "half" : "full"));
  const first = index === 0;
  const last = index === count - 1;
  const menuItem = "block w-full px-3 py-2 text-left text-sm hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent";

  return (
    <>
      {/* sm and up: the compact button row */}
      <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
        <Button type="button" size="sm" variant="outline" disabled={busy || first} onClick={() => move("up")} aria-label="Move up">
          ↑
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || last} onClick={() => move("down")} aria-label="Move down">
          ↓
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={toggleWidth} title="Toggle card width">
          {card.width === "full" ? "Full width" : "Half width"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onDelete}>
          Delete
        </Button>
      </div>

      {/* below sm: one ⋯ menu so the title keeps the whole row */}
      <details className="relative sm:hidden">
        <summary
          aria-label={`Actions for ${card.title}`}
          className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-border text-lg leading-none hover:bg-neutral-800 [&::-webkit-details-marker]:hidden"
        >
          ⋯
        </summary>
        <div
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-neutral-950 shadow-xl"
          onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
        >
          <button type="button" className={menuItem} disabled={busy} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={menuItem} disabled={busy || first} onClick={() => move("top")}>
            Move to top
          </button>
          <button type="button" className={menuItem} disabled={busy || first} onClick={() => move("up")}>
            Move up
          </button>
          <button type="button" className={menuItem} disabled={busy || last} onClick={() => move("down")}>
            Move down
          </button>
          <button type="button" className={menuItem} disabled={busy || last} onClick={() => move("bottom")}>
            Move to bottom
          </button>
          <button type="button" className={menuItem} disabled={busy} onClick={toggleWidth}>
            {card.width === "full" ? "Make half width" : "Make full width"}
          </button>
          <button type="button" className={`${menuItem} text-red-400`} disabled={busy} onClick={onDelete}>
            Delete
          </button>
        </div>
      </details>
    </>
  );
}

export function GuildInfoCards({ cards, canEdit }: { cards: Card[]; canEdit: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable, unique anchor per card (from its title) for the contents list and
  // for in-page [text](#slug) links between cards.
  const slugs = useMemo(() => {
    const seen = new Map<string, number>();
    return cards.map((c) => {
      const base = slugify(c.title);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}-${n}`;
    });
  }, [cards]);

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

  function jump(slug: string) {
    document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${slug}`);
  }

  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-6">
      {cards.length > 1 && (
        <>
          {/* mobile: jump menu */}
          <label className="mb-4 flex flex-col gap-1 text-sm lg:hidden">
            <span className="text-neutral-400">Jump to section</span>
            <select
              className={fieldClasses()}
              value=""
              onChange={(e) => e.target.value && jump(e.target.value)}
            >
              <option value="">Choose a section…</option>
              {cards.map((c, i) => (
                <option key={c.id} value={slugs[i]}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          {/* desktop: sticky contents */}
          <nav aria-label="Contents" className="sticky top-4 hidden max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-border p-3 text-sm lg:block">
            <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Contents</div>
            <ul className="space-y-1">
              {cards.map((c, i) => (
                <li key={c.id}>
                  <a
                    href={`#${slugs[i]}`}
                    onClick={(e) => {
                      e.preventDefault();
                      jump(slugs[i]);
                    }}
                    className="block rounded px-2 py-1 text-neutral-300 hover:bg-neutral-800 hover:text-emerald-300"
                  >
                    {c.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </>
      )}

      <div className={cards.length > 1 ? "" : "lg:col-span-2"}>
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
                <section key={card.id} id={slugs[i]} className="scroll-mt-4 rounded-lg border border-accent/40 bg-neutral-900/40 p-4 md:col-span-2">
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
              <section key={card.id} id={slugs[i]} className={`scroll-mt-4 rounded-lg border border-border p-4 sm:p-5 ${span}`}>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="group min-w-0 text-lg font-semibold leading-snug text-neutral-100">
                    {card.title}
                    <a href={`#${slugs[i]}`} aria-label={`Link to ${card.title}`} className="ml-2 text-sm font-normal text-neutral-600 opacity-0 hover:text-emerald-400 group-hover:opacity-100 focus:opacity-100">
                      #
                    </a>
                  </h2>
                  {canEdit && (
                    <CardActions
                      card={card}
                      index={i}
                      count={cards.length}
                      busy={busy}
                      run={run}
                      onEdit={() => setEditingId(card.id)}
                      onDelete={() => onDelete(card)}
                    />
                  )}
                </div>
                <div className="mt-3">
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
    </div>
  );
}
