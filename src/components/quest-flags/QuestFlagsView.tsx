"use client";

import { useMemo, useState } from "react";

import { fieldClasses } from "@/components/ui/Field";
import type { CharacterKeyFlagRow, SkyBankRewardRow, SkyBankStockRow } from "@/lib/quest-flags/list";

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

function RewardsTab({ rewards, stock }: { rewards: SkyBankRewardRow[]; stock: SkyBankStockRow[] }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("all");

  const classes = useMemo(
    () => [...new Set(rewards.map((r) => r.classRestriction).filter((c): c is string => !!c))].sort(),
    [rewards],
  );

  const filteredRewards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rewards.filter((r) => {
      if (q && !r.itemName.toLowerCase().includes(q) && !r.questName.toLowerCase().includes(q)) return false;
      if (classFilter !== "all" && r.classRestriction !== classFilter) return false;
      return true;
    });
  }, [rewards, search, classFilter]);

  const filteredStock = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? stock.filter((s) => s.itemName.toLowerCase().includes(q)) : stock;
  }, [stock, search]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Item or quest…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-56`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Class</span>
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All classes</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-300">No-Drop reward catalog</h3>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Quest</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Item 2 / 3 / 4</th>
              <th className="px-3 py-2 font-medium">Officer holding</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredRewards.map((r) => (
              <tr key={r.itemName} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">{r.itemName}</td>
                <td className="px-3 py-2 text-neutral-400">{r.questName}</td>
                <td className="px-3 py-2 text-neutral-400">{r.classRestriction ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-400">{r.qty}</td>
                <td className="px-3 py-2 text-neutral-500">
                  {[r.item2Status, r.item3Status, r.item4Status].filter(Boolean).join(" / ") || "—"}
                </td>
                <td className="px-3 py-2 text-neutral-500">{r.officerHolding ?? "—"}</td>
              </tr>
            ))}
            {filteredRewards.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  No rewards match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-neutral-300">Stock (hand-counted)</h3>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[320px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredStock.map((s) => (
              <tr key={s.itemName} className="hover:bg-neutral-900/40">
                <td className="px-3 py-2 font-medium">{s.itemName}</td>
                <td className="px-3 py-2 text-neutral-400">{s.qty}</td>
              </tr>
            ))}
            {filteredStock.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-neutral-500">
                  No stock matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QuestFlagsView({
  keyFlags,
  rewards,
  stock,
}: {
  keyFlags: CharacterKeyFlagRow[];
  rewards: SkyBankRewardRow[];
  stock: SkyBankStockRow[];
}) {
  const [tab, setTab] = useState<"keys" | "skybank">("keys");

  return (
    <div>
      <div className="mb-4 flex gap-2 border-b border-border">
        {(["keys", "skybank"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t ? "border-b-2 border-accent text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {t === "keys" ? "EmpVT / ST Keys" : "Sky Bank"}
          </button>
        ))}
      </div>
      {tab === "keys" ? <KeysTab rows={keyFlags} /> : <RewardsTab rewards={rewards} stock={stock} />}
    </div>
  );
}
