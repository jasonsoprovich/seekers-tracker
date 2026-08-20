"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteLedgerEntry, updateLedgerEntry } from "@/app/(app)/epgp/ledger/actions";
import { fieldClasses } from "@/components/ui/Field";

export type EpRow = {
  id: number;
  characterName: string;
  occurredAt: Date;
  activity: string;
  points: number;
  note: string | null;
  source: "import" | "manual" | "parse";
  enteredByName: string | null;
};

export type GpRow = {
  id: number;
  characterName: string;
  occurredAt: Date;
  itemName: string | null;
  tier: string;
  points: number;
  note: string | null;
  source: "import" | "manual" | "parse";
  enteredByName: string | null;
};

type Props = { type: "ep"; rows: EpRow[]; canManage: boolean } | { type: "gp"; rows: GpRow[]; canManage: boolean };

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type Draft = { activityOrTier: string; itemName: string; points: string; occurredAt: string; note: string };

export function LedgerTable(props: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ activityOrTier: "", itemName: "", points: "", occurredAt: "", note: "" });

  const baseCols = props.type === "ep" ? 6 : 7;
  const totalCols = props.canManage ? baseCols + 1 : baseCols;

  function startEdit(row: EpRow | GpRow) {
    setEditingId(row.id);
    setError(null);
    setDraft({
      activityOrTier: props.type === "ep" ? (row as EpRow).activity : (row as GpRow).tier,
      itemName: props.type === "gp" ? ((row as GpRow).itemName ?? "") : "",
      points: String(row.points),
      occurredAt: toDateInputValue(row.occurredAt),
      note: row.note ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function saveEdit(id: number) {
    const points = Number(draft.points);
    if (!Number.isFinite(points)) {
      setError("Points must be a number.");
      return;
    }
    if (!draft.activityOrTier.trim()) {
      setError(props.type === "ep" ? "Activity is required." : "Tier is required.");
      return;
    }
    setPending(true);
    setError(null);
    const result =
      props.type === "ep"
        ? await updateLedgerEntry({ kind: "ep", id, activity: draft.activityOrTier, points, occurredAt: draft.occurredAt, note: draft.note })
        : await updateLedgerEntry({
            kind: "gp",
            id,
            tier: draft.activityOrTier,
            itemName: draft.itemName,
            points,
            occurredAt: draft.occurredAt,
            note: draft.note,
          });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditingId(null);
    router.refresh();
  }

  async function onDelete(id: number, characterName: string) {
    const label = props.type === "ep" ? "EP" : "GP";
    if (!confirm(`Delete this ${label} entry for ${characterName}? This can't be undone.`)) return;
    setPending(true);
    setError(null);
    const result = await deleteLedgerEntry(props.type, id);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Character</th>
              {props.type === "ep" ? (
                <th className="px-3 py-2 font-medium">Activity</th>
              ) : (
                <>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                </>
              )}
              <th className="px-3 py-2 font-medium">Points</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Recorded by</th>
              {props.canManage && <th className="px-3 py-2 font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {props.rows.map((r) => {
              const editing = editingId === r.id;
              return (
                <tr key={r.id} className="hover:bg-neutral-900/40">
                  {editing ? (
                    <>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={draft.occurredAt}
                          onChange={(e) => setDraft((d) => ({ ...d, occurredAt: e.target.value }))}
                          className={fieldClasses({ size: "sm" })}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-neutral-400">{r.characterName}</td>
                      {props.type === "ep" ? (
                        <td className="px-3 py-2">
                          <input
                            value={draft.activityOrTier}
                            onChange={(e) => setDraft((d) => ({ ...d, activityOrTier: e.target.value }))}
                            className={fieldClasses({ size: "sm" })}
                          />
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2">
                            <input
                              value={draft.itemName}
                              onChange={(e) => setDraft((d) => ({ ...d, itemName: e.target.value }))}
                              className={fieldClasses({ size: "sm" })}
                              placeholder="Item"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={draft.activityOrTier}
                              onChange={(e) => setDraft((d) => ({ ...d, activityOrTier: e.target.value }))}
                              className={fieldClasses({ size: "sm" })}
                              placeholder="Tier"
                            />
                          </td>
                        </>
                      )}
                      <td className="px-3 py-2">
                        <input
                          value={draft.points}
                          onChange={(e) => setDraft((d) => ({ ...d, points: e.target.value }))}
                          inputMode="decimal"
                          className={`${fieldClasses({ size: "sm" })} w-20`}
                        />
                      </td>
                      <td className="px-3 py-2 text-neutral-500">{r.source}</td>
                      <td className="px-3 py-2 text-neutral-500">{r.enteredByName ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => saveEdit(r.id)}
                            className="text-emerald-400 hover:text-emerald-300 disabled:opacity-60"
                          >
                            {pending ? "Saving…" : "Save"}
                          </button>
                          <button type="button" disabled={pending} onClick={cancelEdit} className="text-neutral-400 hover:text-neutral-200">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-neutral-400">{r.occurredAt.toLocaleDateString()}</td>
                      <td className="px-3 py-2 font-medium">{r.characterName}</td>
                      {props.type === "ep" ? (
                        <td className="px-3 py-2 text-neutral-400">{(r as EpRow).activity}</td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-neutral-400">{(r as GpRow).itemName ?? "—"}</td>
                          <td className="px-3 py-2 text-neutral-400">{(r as GpRow).tier}</td>
                        </>
                      )}
                      <td className={`px-3 py-2 font-medium ${r.points < 0 ? "text-red-400" : "text-emerald-400"}`}>{r.points}</td>
                      <td className="px-3 py-2 text-neutral-500">{r.source}</td>
                      <td className="px-3 py-2 text-neutral-500">{r.enteredByName ?? "—"}</td>
                      {props.canManage && (
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <button type="button" onClick={() => startEdit(r)} className="text-neutral-300 hover:text-neutral-100">
                              Edit
                            </button>
                            <button type="button" onClick={() => onDelete(r.id, r.characterName)} className="text-red-400 hover:text-red-300">
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </>
                  )}
                </tr>
              );
            })}
            {props.rows.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="px-3 py-6 text-center text-neutral-500">
                  No rows match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
