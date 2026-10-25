"use client";

import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import type { CharacterKeyFlagRow } from "@/lib/quest-flags/list";

function Pill({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        done ? "bg-emerald-500/15 text-emerald-400" : "bg-neutral-800 text-neutral-500"
      }`}
    >
      {done ? "✓" : "—"} {label}
    </span>
  );
}

function KeysTab({ rows }: { rows: CharacterKeyFlagRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.stKeys.some((k) => k.label.toLowerCase().includes(q)),
    );
  }, [rows, search]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Character or key item…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-56`}
          />
        </label>
        <span className="pb-1.5 text-sm text-neutral-500">
          {filtered.length} of {rows.length} character{rows.length === 1 ? "" : "s"} with a key on file
        </span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Character</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">EmpVT</th>
              <th className="px-3 py-2 font-medium">ST keys</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((r) => (
              <tr key={r.characterId} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 text-neutral-400">{r.className}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Pill done={r.empKeyDone} label="Emp" />
                    <Pill done={r.vtKeyDone} label="VT" />
                  </div>
                </td>
                <td className="px-3 py-2">
                  {r.stKeys.length === 0 ? (
                    <span className="text-neutral-500">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {r.stKeys.map((k) => (
                        <Pill key={k.label} done={k.done} label={k.label} />
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-neutral-500">
                  No characters match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QuestFlagsView({ keyFlags }: { keyFlags: CharacterKeyFlagRow[] }) {
  return <KeysTab rows={keyFlags} />;
}
