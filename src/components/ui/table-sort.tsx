"use client";

import { useMemo, useRef, useState } from "react";

// Shared client-side column sorting for the app's data tables
// (post-live-test-1 LT-19). A table passes its rows plus an accessor per
// sortable column; the header cells become <SortableTh> buttons that cycle
// asc → desc. Nulls always sort last. String compares are locale + numeric
// ("Bag 2" before "Bag 10").

export type SortDir = "asc" | "desc";
export type SortState<K extends string> = { key: K; dir: SortDir } | null;
export type Accessor<T> = (row: T) => string | number | boolean | null | undefined;

export function useTableSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, Accessor<T>>,
  initial: SortState<K> = null,
) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  // Accessors are defined inline by callers and so are a fresh object every
  // render; keep them in a ref so the memo below only re-runs on rows/sort.
  const accRef = useRef(accessors);
  accRef.current = accessors;

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accRef.current[sort.key];
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
  }, [rows, sort]);

  function toggle(key: K) {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  return { sorted, sort, toggle };
}

export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  return (
    <th className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 font-medium transition-colors hover:text-neutral-200"
        aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="text-[10px] opacity-50">{active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
