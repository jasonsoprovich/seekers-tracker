"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useItemTooltipsEnabled } from "@/components/items/ItemTooltipsProvider";
import { sanitizeTooltip } from "@/lib/items/sanitize-tooltip";

const PQDI_ITEM = "https://www.pqdi.cc/item/";

// ---- name -> id, batched ---------------------------------------------------
// Every ItemLink on a page asks for its id in the same tick; one POST resolves
// them all. Results are memoized for the session (null = "not a known item").
const idCache = new Map<string, number | null>();
const pending = new Map<string, Array<(id: number | null) => void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  flushTimer = null;
  const names = [...pending.keys()];
  const waiters = new Map(pending);
  pending.clear();
  for (let i = 0; i < names.length; i += 200) {
    const batch = names.slice(i, i + 200);
    let ids: Record<string, number | null> = {};
    try {
      const res = await fetch("/api/items/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: batch }),
      });
      if (res.ok) ids = ((await res.json()) as { ids: Record<string, number | null> }).ids;
    } catch {
      // network failure: leave the names as plain text, don't cache
      for (const n of batch) for (const w of waiters.get(n) ?? []) w(null);
      continue;
    }
    for (const n of batch) {
      const id = ids[n] ?? null;
      idCache.set(n, id);
      for (const w of waiters.get(n) ?? []) w(id);
    }
  }
}

function resolveName(name: string): Promise<number | null> {
  if (idCache.has(name)) return Promise.resolve(idCache.get(name) ?? null);
  return new Promise((resolve) => {
    const list = pending.get(name) ?? [];
    list.push(resolve);
    pending.set(name, list);
    flushTimer ??= setTimeout(flush, 25);
  });
}

// ---- tooltip html, cached per item ----------------------------------------
const tipCache = new Map<number, Promise<string | null>>();
function loadTip(id: number): Promise<string | null> {
  let p = tipCache.get(id);
  if (!p) {
    p = fetch(`/api/items/${id}/tooltip`)
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => (html ? sanitizeTooltip(html) : null))
      .then((clean) => {
        if (clean) preloadIcons(clean);
        return clean;
      })
      .catch(() => null);
    tipCache.set(id, p);
    p.then((v) => v === null && tipCache.delete(id)); // retry later after a failure
  }
  return p;
}

// Warm the browser cache for the icon sprite so it doesn't pop in after the text.
const preloaded = new Set<string>();
function preloadIcons(html: string) {
  for (const m of html.matchAll(/url\(&quot;([^&]+)&quot;\)/g)) {
    if (preloaded.has(m[1])) continue;
    preloaded.add(m[1]);
    new Image().src = m[1];
  }
}

function Tooltip({ id, anchor, onClose }: { id: number; anchor: DOMRect; onClose: () => void }) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let live = true;
    loadTip(id).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.left, vw - width - 8));
    let top = anchor.bottom + 6;
    if (top + height > vh - 8 && anchor.top - height - 6 > 8) top = anchor.top - height - 6;
    setPos({ left, top: Math.max(8, top) });
  }, [anchor, html]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Tap/click outside closes it (touch has no mouseleave). A press on an
    // item link is left alone — that link's own handlers decide.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && (ref.current?.contains(t) || t.closest(".pqdi-link"))) return;
      onClose();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pqdi-tip"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
    >
      {html === undefined && <span className="pqdi-tip-status">Loading…</span>}
      {html === null && <span className="pqdi-tip-status">Tooltip unavailable.</span>}
      {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
      <a className="pqdi-tip-link" href={`${PQDI_ITEM}${id}`} target="_blank" rel="noopener noreferrer">
        Open on PQDI ↗
      </a>
    </div>,
    document.body,
  );
}

// An item name that, when the admin has item tooltips switched on, links to
// PQDI and shows its tooltip on hover (desktop), focus, or first tap (touch).
// With tooltips off — or for a name that isn't a known item — it renders the
// children/name exactly as plain text, with no network requests.
export function ItemLink({ name, itemId, children, className }: { name: string; itemId?: number | null; children?: ReactNode; className?: string }) {
  const enabled = useItemTooltipsEnabled();
  const [id, setId] = useState<number | null>(itemId ?? idCache.get(name) ?? null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const el = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!enabled || itemId != null || id != null) return;
    let live = true;
    resolveName(name).then((r) => live && setId(r));
    return () => {
      live = false;
    };
  }, [enabled, itemId, id, name]);

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  const open = useCallback(() => {
    if (el.current) setAnchor(el.current.getBoundingClientRect());
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const shown = children ?? name;
  const itemIdResolved = itemId ?? id;
  if (!enabled || !itemIdResolved) return <>{shown}</>;

  const touch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
  return (
    <>
      <a
        ref={el}
        href={`${PQDI_ITEM}${itemIdResolved}`}
        target="_blank"
        rel="noopener noreferrer"
        className={`pqdi-link ${className ?? ""}`}
        onMouseEnter={() => {
          if (touch) return;
          void loadTip(itemIdResolved); // start fetching now; the popup opens after the delay
          timer.current = setTimeout(open, 150);
        }}
        onMouseLeave={() => !touch && close()}
        onFocus={() => {
          void loadTip(itemIdResolved);
          open();
        }}
        onBlur={close}
        onClick={(e) => {
          e.stopPropagation(); // item links sit in clickable rows (raid loot, bank groups)
          // On touch, the first tap shows the tooltip (it carries an "Open on PQDI" link).
          if (touch && !anchor) {
            e.preventDefault();
            open();
          }
        }}
      >
        {shown}
      </a>
      {anchor && <Tooltip id={itemIdResolved} anchor={anchor} onClose={close} />}
    </>
  );
}
