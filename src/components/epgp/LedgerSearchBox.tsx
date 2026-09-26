"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

// Real regression, found 2026-09-26 while building an unrelated feature
// that reused this component: this used to take a `buildHref: (q: string)
// => string` prop, built server-side by the page component and handed
// down. A Server Component can't pass a plain function to a Client
// Component like this one — functions aren't serializable across that
// boundary (only "use server" Server Actions are) — so every render of
// this component threw "Functions cannot be passed directly to Client
// Components" and 500'd the whole page. This had shipped on
// feature/guild-bank-sync, never merged to main, and was never actually
// browser-verified (CLAUDE.md logs it as a same-session "rode along,
// unrelated" addition, verified only by tsc/build — and next lint, which
// would normally flag exactly this, has been broken in this repo since
// before this component existed). Fixed by having the component build its
// own next-URL client-side (usePathname/useSearchParams, both ordinary
// client hooks reading the browser's current location) instead of being
// handed one from the server — no function ever crosses the RSC boundary.
export function LedgerSearchBox({
  initialQuery,
  placeholder,
}: {
  initialQuery: string;
  placeholder: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The URL's own q (and which tab we're on) can change from outside this
  // component — clicking a different tab, or a stale timer from a prior
  // keystroke landing after navigation. Keep the input in sync with it.
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  // Keeps every other current param (tab/type) untouched, sets/clears q,
  // and resets page to 1 — the same contract the old server-built
  // buildHref had, just derived from the browser's own current URL.
  function hrefFor(q: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (q) params.set("q", q);
    else params.delete("q");
    params.set("page", "1");
    return `${pathname}?${params.toString()}`;
  }

  function commit(q: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    startTransition(() => {
      router.replace(hrefFor(q));
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
