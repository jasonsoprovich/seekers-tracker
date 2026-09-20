"use client";

import { useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import { EXPORT_GROUP_ORDER, type ExportTable } from "@/lib/export/tables";

// Admin+leader-only CSV export — /admin/logs "Export" tab. Checkbox list
// grouped by ExportTable.group, a shared date range, a row-count preview
// (GET .../export?count=1 before committing to a download), and one
// download per checked table (no ZIP — see src/lib/export/tables.ts's file
// comment). A real browser download via a temporary <a download> click —
// this is the app itself, not an Artifact preview, so the usual download
// path works.
export function ExportPanel({ tables }: { tables: ExportTable[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function previewCounts() {
    if (selected.size === 0) return;
    setCountsLoading(true);
    try {
      const params = new URLSearchParams({ count: "1", tables: [...selected].join(",") });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/admin/export?${params.toString()}`);
      if (res.ok) setCounts(await res.json());
    } finally {
      setCountsLoading(false);
    }
  }

  async function download() {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      // One request per table, staggered slightly so a multi-select doesn't
      // fire N simultaneous downloads the browser has to juggle at once.
      let i = 0;
      for (const key of selected) {
        const params = new URLSearchParams({ table: key });
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        const href = `/api/admin/export?${params.toString()}`;
        const a = document.createElement("a");
        a.href = href;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        i++;
        if (i < selected.size) await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldClasses({ size: "sm" })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldClasses({ size: "sm" })} />
        </label>
        <span className="text-xs text-neutral-500">Applies only to tables with a date column — others always export in full.</span>
      </div>

      {EXPORT_GROUP_ORDER.map((group) => {
        const groupTables = tables.filter((t) => t.group === group);
        if (groupTables.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="text-sm font-semibold text-neutral-300">{group}</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groupTables.map((t) => {
                const count = counts[t.key];
                return (
                  <label
                    key={t.key}
                    className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-neutral-900/40"
                  >
                    <input type="checkbox" checked={selected.has(t.key)} onChange={() => toggle(t.key)} className="mt-0.5" />
                    <span>
                      <span className="block font-medium text-neutral-200">{t.label}</span>
                      <span className="block text-xs text-neutral-500">
                        {t.dateColumn ? "date-range filterable" : "full table — date range not applied"}
                        {count != null && <span className="ml-1">· {count.toLocaleString()} rows</span>}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={previewCounts}
          disabled={selected.size === 0 || countsLoading}
          className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60 disabled:opacity-50"
        >
          {countsLoading ? "Counting…" : "Preview row counts"}
        </button>
        <button
          type="button"
          onClick={download}
          disabled={selected.size === 0 || downloading}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/90 disabled:opacity-50"
        >
          {downloading ? "Starting downloads…" : `Download ${selected.size > 0 ? `(${selected.size})` : ""}`}
        </button>
      </div>
    </div>
  );
}
