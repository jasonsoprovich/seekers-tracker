"use client";

import { useState, type ReactNode } from "react";

// Phase 6 task 6.5: a compact, expandable mobile substitute for a data-table
// row — used alongside (never instead of) the real <table>, which stays the
// sm:+ rendering; this is what a table's <tbody> maps to below the sm
// breakpoint via CSS (`hidden sm:block` / `sm:hidden` on the two
// containers), not a JS media-query switch, so there's no hydration
// mismatch between server and client render.
//
// `summary` sits beside a dedicated disclosure button rather than being the
// button itself — several callers' summaries carry their own interactive
// content (RosterTable's alt-toggle, a character name <Link>), and the
// HTML button/a content model forbids nested interactive descendants
// (a real one: React's own hydration-mismatch warning caught a `<button>`
// nested inside this component's own toggle button during Phase 6). Pass
// no `detail` for a row with nothing worth hiding (renders as a plain
// non-interactive card, no toggle at all).
export function MobileCard({
  summary,
  detail,
  defaultOpen = false,
  accent = false,
}: {
  summary: ReactNode;
  detail?: ReactNode;
  defaultOpen?: boolean;
  accent?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const border = `rounded-lg border border-border ${accent ? "bg-neutral-900/40" : "bg-neutral-950"}`;

  if (!detail) {
    return <div className={`${border} px-3 py-2`}>{summary}</div>;
  }

  return (
    <div className={border}>
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">{summary}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-200"
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && <div className="border-t border-border px-3 py-2">{detail}</div>}
    </div>
  );
}
