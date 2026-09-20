"use client";

import { Fragment, useState } from "react";

import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import type { SystemEventCategory } from "@/lib/system-log";
import { guildDateTime } from "@/lib/guild-timezone";

export type SystemLogRow = {
  id: number;
  occurredAt: Date;
  actorLabel: string | null;
  actorRole: string | null;
  source: "web" | "officer_api" | "cron" | "script";
  category: SystemEventCategory | string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  requestId: string | null;
};

const CATEGORY_STYLE: Record<string, string> = {
  membership: "text-emerald-400",
  roles: "text-amber-400",
  characters: "text-sky-400",
  permissions: "text-red-400",
  epgp: "text-violet-400",
  bank: "text-lime-400",
  claims: "text-cyan-400",
  system: "text-neutral-400",
};

type Col = "when" | "actor" | "category" | "action" | "target";

// Read-only, admin+leader-only — the debugging counterpart to
// AuditLogTable (member-visible, EP/GP-ledger-only). Every row expands to
// its raw before/after JSON snapshot; nothing here is ever editable.
export function SystemLogTable({ rows }: { rows: SystemLogRow[] }) {
  const { sorted, sort, toggle } = useTableSort<SystemLogRow, Col>(rows, {
    when: (r) => r.occurredAt.getTime(),
    actor: (r) => r.actorLabel,
    category: (r) => r.category,
    action: (r) => r.action,
    target: (r) => r.targetLabel,
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <SortableTh className="px-3 py-2" label="When" sortKey="when" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Actor" sortKey="actor" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Category" sortKey="category" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Action" sortKey="action" sort={sort} onSort={toggle} />
            <SortableTh className="px-3 py-2" label="Target" sortKey="target" sort={sort} onSort={toggle} />
            <th className="px-3 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => {
            const isOpen = expanded === r.id;
            const hasDetail = r.before != null || r.after != null || r.requestId != null;
            return (
              <Fragment key={r.id}>
                <tr
                  className={`align-top hover:bg-neutral-900/40 ${hasDetail ? "cursor-pointer" : ""}`}
                  onClick={() => hasDetail && setExpanded(isOpen ? null : r.id)}
                >
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-400">{guildDateTime(r.occurredAt)}</td>
                  <td className="px-3 py-2 font-medium">
                    {r.actorLabel ?? "—"}
                    {r.actorRole && <span className="ml-1 text-[11px] text-neutral-500">({r.actorRole})</span>}
                    {r.source !== "web" && <span className="ml-1 text-[11px] text-neutral-600">[{r.source}]</span>}
                  </td>
                  <td className={`px-3 py-2 font-medium ${CATEGORY_STYLE[r.category] ?? "text-neutral-300"}`}>{r.category}</td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-400">{r.action}</td>
                  <td className="px-3 py-2 text-neutral-300">
                    {r.targetLabel ?? (r.targetType && r.targetId ? `${r.targetType} #${r.targetId}` : "—")}
                  </td>
                  <td className="px-3 py-2 text-neutral-300">
                    {r.summary}
                    {hasDetail && <span className="ml-2 text-[11px] text-neutral-600">{isOpen ? "▾ hide detail" : "▸ show detail"}</span>}
                  </td>
                </tr>
                {isOpen && hasDetail && (
                  <tr className="bg-neutral-950/60">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {r.before != null && (
                          <div>
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">Before</div>
                            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-neutral-900/60 p-2 text-xs text-neutral-300">
                              {JSON.stringify(r.before, null, 2)}
                            </pre>
                          </div>
                        )}
                        {r.after != null && (
                          <div>
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">After</div>
                            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-neutral-900/60 p-2 text-xs text-neutral-300">
                              {JSON.stringify(r.after, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                      {r.requestId && <div className="mt-2 text-[11px] text-neutral-600">request id: {r.requestId}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                No system events recorded for this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
