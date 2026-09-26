"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { fieldClasses } from "@/components/ui/Field";

// 2026-09-25 officer feedback: the Roster search narrows as you type; this
// page (EP/GP/Bids/Totals/Audit search) only searched on Enter/Search-
// click. That WAS deliberate — see this component's call site's own
// comment — but the officers asked for parity with Roster, and this repo's
// EPGP Ledger read paths (getTotalsRows/listLedgerRows/listBidHistory) are
// already server-side paginated LIMIT/OFFSET queries against up to ~47k/
// 5.9k rows, not a client-side filter over the whole table — so debouncing
// the query instead of requiring Enter is safe: one query per pause in
// typing, not one per keystroke. 350ms chosen to comfortably clear normal
// typing cadence without feeling laggy.
const DEBOUNCE_MS = 350;

export function LedgerSearchBox({
  initialQuery,
  placeholder,
  buildHref,
}: {
  initialQuery: string;
  placeholder: string;
  // Given the next query string, returns the full /epgp/ledger?... URL
  // (tab kept, page reset to 1) — the page component already owns that
  // logic (pageHref) and this component shouldn't have to re-derive it.
  buildHref: (q: string) => string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The URL's own q (and which tab we're on) can change from outside this
  // component — clicking a different tab, or a stale timer from a prior
  // keystroke landing after navigation. Keep the input in sync with it.
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  function commit(q: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    startTransition(() => {
      router.replace(buildHref(q));
    });
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => commit(next), DEBOUNCE_MS);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(value);
    }
  }

  function onClear() {
    setValue("");
    commit("");
  }

  return (
    <div className="flex items-end gap-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Search</span>
        <input
          type="text"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`${fieldClasses({ size: "sm" })} w-56`}
        />
      </label>
      {isPending && <span className="pb-1.5 text-xs text-neutral-500">Searching…</span>}
      {value && !isPending && (
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
