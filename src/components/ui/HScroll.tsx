"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

// Horizontal scroller for wide tables. Adds a second scrollbar ABOVE the
// content (a 50-200 row table puts the native bottom one far off-screen),
// always-visible styled scrollbars (macOS hides overlay ones), and a
// right-edge fade + hint while more columns are off to the right.
export function HScroll({ children, className = "" }: { children: ReactNode; className?: string }) {
  const topRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [contentWidth, setContentWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    setContentWidth(main.scrollWidth);
    setOverflowing(main.scrollWidth > main.clientWidth + 1);
    setAtEnd(main.scrollLeft + main.clientWidth >= main.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    if (main.firstElementChild) ro.observe(main.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  function sync(from: "top" | "main") {
    const top = topRef.current;
    const main = mainRef.current;
    if (!top || !main) return;
    if (syncing.current) {
      syncing.current = false;
      return;
    }
    syncing.current = true;
    if (from === "top") main.scrollLeft = top.scrollLeft;
    else top.scrollLeft = main.scrollLeft;
    measure();
  }

  return (
    <div className={className}>
      {overflowing && (
        <div className="mb-1 flex items-center justify-between gap-3 text-xs text-neutral-500">
          <span>{atEnd ? "← Scroll back for earlier columns" : "Scroll → for more columns (Note, Actions)"}</span>
        </div>
      )}
      <div ref={topRef} onScroll={() => sync("top")} className={`scrollbar-visible overflow-x-auto ${overflowing ? "" : "hidden"}`} aria-hidden="true">
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div className="relative">
        <div ref={mainRef} onScroll={() => sync("main")} className="scrollbar-visible overflow-x-auto rounded-lg border border-border">
          {children}
        </div>
        {overflowing && !atEnd && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-lg bg-gradient-to-l from-black/60 to-transparent" />
        )}
      </div>
    </div>
  );
}
