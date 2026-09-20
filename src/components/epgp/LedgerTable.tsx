"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteLedgerEntry, updateLedgerEntry } from "@/app/(app)/epgp/ledger/actions";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fieldClasses, Field } from "@/components/ui/Field";
import { MobileCard } from "@/components/ui/MobileCard";
import { SortableTh, useTableSort } from "@/components/ui/table-sort";
import { ledgerDate } from "@/lib/format-date";
import type { EpLedgerRow as EpRow, GpLedgerRow as GpRow } from "@/lib/epgp/ledger-list";

export type { EpLedgerRow as EpRow, GpLedgerRow as GpRow } from "@/lib/epgp/ledger-list";

type Props = { type: "ep"; rows: EpRow[]; canManage: boolean } | { type: "gp"; rows: GpRow[]; canManage: boolean };

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type Draft = { activityOrTier: string; itemName: string; points: string; occurredAt: string; note: string; zone: string; raidDate: string };

export function LedgerTable(props: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ activityOrTier: "", itemName: "", points: "", occurredAt: "", note: "", zone: "", raidDate: "" });

  // Click-to-sort columns (LT-19). Default order (as fetched: occurredAt
  // desc) is kept until the officer picks a column. `activityOrItem` /
  // `zoneOrBid` cover whichever pair the current tab shows.
  type Col = "date" | "character" | "activityOrItem" | "zoneOrBid" | "points" | "source" | "recordedBy";
  const { sorted, sort, toggle } = useTableSort<EpRow | GpRow, Col>(props.rows, {
    date: (r) => r.occurredAt.getTime(),
    character: (r) => r.characterName,
    activityOrItem: (r) => (props.type === "ep" ? (r as EpRow).activity : ((r as GpRow).itemName ?? "")),
    zoneOrBid: (r) => (props.type === "ep" ? ((r as EpRow).zone ?? "") : (r as GpRow).tier),
    points: (r) => r.points,
    source: (r) => r.source,
    recordedBy: (r) => r.enteredByName,
  });

  // EP: Date, Linked event, Character, Activity, Zone, Points, Source,
  // Recorded by, Note. GP swaps Activity/Zone for Item/Bid.
  const baseCols = 9;
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
      zone: props.type === "ep" ? ((row as EpRow).zone ?? "") : "",
      raidDate: props.type === "ep" ? ((row as EpRow).raidDate ?? "") : ((row as GpRow).raidDate ?? ""),
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
      setError(props.type === "ep" ? "Activity is required." : "Bid is required.");
      return;
    }
    setPending(true);
    setError(null);
    const result =
      props.type === "ep"
        ? await updateLedgerEntry({ kind: "ep", id, activity: draft.activityOrTier, points, occurredAt: draft.occurredAt, note: draft.note, zone: draft.zone, raidDate: draft.raidDate })
        : await updateLedgerEntry({
            kind: "gp",
            id,
            tier: draft.activityOrTier,
            itemName: draft.itemName,
            points,
            occurredAt: draft.occurredAt,
            note: draft.note,
            raidDate: draft.raidDate,
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
    const ok = await confirm({
      title: "Delete ledger entry?",
      message: `Delete this ${label} entry for ${characterName}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
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

  // Mobile substitute for a table row (task 6.5): a compact card, expandable
  // to the same fields the desktop table's extra columns show. A row being
  // edited renders as a stacked mini-form instead — the same input elements
  // as the desktop edit row, laid out as labeled fields rather than <td>s.
  function renderMobileCard(r: EpRow | GpRow) {
    const editing = editingId === r.id;
    if (editing) {
      return (
        <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-neutral-900/40 p-3">
          <Field>
            <span className="text-neutral-400">Date</span>
            <input
              type="date"
              value={draft.occurredAt}
              onChange={(e) => setDraft((d) => ({ ...d, occurredAt: e.target.value }))}
              className={fieldClasses()}
            />
          </Field>
          <div className="text-sm text-neutral-500">{r.characterName}</div>
          {props.type === "ep" ? (
            <>
              <Field>
                <span className="text-neutral-400">Activity</span>
                <input
                  value={draft.activityOrTier}
                  onChange={(e) => setDraft((d) => ({ ...d, activityOrTier: e.target.value }))}
                  className={fieldClasses()}
                />
              </Field>
              <Field>
                <span className="text-neutral-400">Zone</span>
                <input
                  value={draft.zone}
                  onChange={(e) => setDraft((d) => ({ ...d, zone: e.target.value }))}
                  className={fieldClasses()}
                  placeholder="Zone"
                />
              </Field>
              <Field>
                <span className="text-neutral-400">Raid / event date</span>
                <input
                  type="date"
                  value={draft.raidDate}
                  onChange={(e) => setDraft((d) => ({ ...d, raidDate: e.target.value }))}
                  className={fieldClasses()}
                />
              </Field>
            </>
          ) : (
            <>
              <Field>
                <span className="text-neutral-400">Item</span>
                <input
                  value={draft.itemName}
                  onChange={(e) => setDraft((d) => ({ ...d, itemName: e.target.value }))}
                  className={fieldClasses()}
                  placeholder="Item"
                />
              </Field>
              <Field>
                <span className="text-neutral-400">Bid</span>
                <input
                  value={draft.activityOrTier}
                  onChange={(e) => setDraft((d) => ({ ...d, activityOrTier: e.target.value }))}
                  className={fieldClasses()}
                  placeholder="Bid"
                />
              </Field>
              <Field>
                <span className="text-neutral-400">Raid / event date</span>
                <input
                  type="date"
                  value={draft.raidDate}
                  onChange={(e) => setDraft((d) => ({ ...d, raidDate: e.target.value }))}
                  className={fieldClasses()}
                />
              </Field>
            </>
          )}
          <Field>
            <span className="text-neutral-400">Points</span>
            <input
              value={draft.points}
              onChange={(e) => setDraft((d) => ({ ...d, points: e.target.value }))}
              inputMode="decimal"
              className={fieldClasses()}
            />
          </Field>
          <Field>
            <span className="text-neutral-400">Note</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              className={fieldClasses()}
              placeholder="Note"
            />
          </Field>
          <div className="flex gap-4 pt-1">
            <button
              type="button"
              disabled={pending}
              onClick={() => saveEdit(r.id)}
              className="min-h-9 text-sm font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={pending} onClick={cancelEdit} className="min-h-9 text-sm text-neutral-400 hover:text-neutral-200">
              Cancel
            </button>
          </div>
        </div>
      );
    }

    const summary = (
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{r.characterName}</span>
          <span className={`font-medium ${r.points < 0 ? "text-red-400" : "text-emerald-400"}`}>{r.points}</span>
        </div>
        <div className="mt-0.5 text-xs text-neutral-500">
          {ledgerDate(r.occurredAt, r.source)} · {props.type === "ep" ? (r as EpRow).activity : ((r as GpRow).itemName ?? "—")}
        </div>
      </div>
    );

    const detail = (
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-neutral-500">{props.type === "ep" ? "Zone" : "Bid"}</dt>
          <dd className="text-neutral-300">{props.type === "ep" ? ((r as EpRow).zone ?? "—") : (r as GpRow).tier}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Source</dt>
          <dd className="text-neutral-300">{r.source}</dd>
        </div>
        {(props.type === "ep" ? (r as EpRow).raidDate : (r as GpRow).raidDate) && (
          <div>
            <dt className="text-neutral-500">Linked event</dt>
            <dd>
              <Link href={`/epgp/raids/${props.type === "ep" ? (r as EpRow).raidDate : (r as GpRow).raidDate}`} className="text-accent hover:underline">
                {props.type === "ep" ? (r as EpRow).raidDate : (r as GpRow).raidDate}
              </Link>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-neutral-500">Recorded by</dt>
          <dd className="text-neutral-300">{r.enteredByName ?? "—"}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-neutral-500">Note</dt>
          <dd className="text-neutral-300">{r.note || "—"}</dd>
        </div>
        {props.canManage && (
          <div className="col-span-2 flex gap-4 pt-1">
            <button
              type="button"
              onClick={() => startEdit(r)}
              className="min-h-9 text-sm text-neutral-300 hover:text-neutral-100"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDelete(r.id, r.characterName)}
              className="min-h-9 text-sm text-red-400 hover:text-red-300"
            >
              Delete
            </button>
          </div>
        )}
      </dl>
    );

    return <MobileCard key={r.id} summary={summary} detail={detail} />;
  }

  return (
    <>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      <div className="flex flex-col gap-2 sm:hidden">
        {sorted.map(renderMobileCard)}
        {props.rows.length === 0 && (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-neutral-500">No rows match this search.</div>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
        <table className="w-full min-w-[1040px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <SortableTh className="px-3 py-2" label="Date" sortKey="date" sort={sort} onSort={toggle} />
              <th className="px-3 py-2 font-medium">Linked event</th>
              <SortableTh className="px-3 py-2" label="Character" sortKey="character" sort={sort} onSort={toggle} />
              {props.type === "ep" ? (
                <>
                  <SortableTh className="px-3 py-2" label="Activity" sortKey="activityOrItem" sort={sort} onSort={toggle} />
                  <SortableTh className="px-3 py-2" label="Zone" sortKey="zoneOrBid" sort={sort} onSort={toggle} />
                </>
                       ) : (
                         <>
                  <SortableTh className="px-3 py-2" label="Item" sortKey="activityOrItem" sort={sort} onSort={toggle} />
                  <SortableTh className="px-3 py-2" label="Bid" sortKey="zoneOrBid" sort={sort} onSort={toggle} />
                </>
              )}
              <SortableTh className="px-3 py-2" label="Points" sortKey="points" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Source" sortKey="source" sort={sort} onSort={toggle} />
              <SortableTh className="px-3 py-2" label="Recorded by" sortKey="recordedBy" sort={sort} onSort={toggle} />
              <th className="px-3 py-2 font-medium">Note</th>
              {props.canManage && <th className="sticky right-0 z-10 bg-neutral-900 px-3 py-2 font-medium shadow-[-1px_0_0_0_rgb(38_38_38)]">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((r) => {
              const editing = editingId === r.id;
              const linkedEventDate = props.type === "ep" ? (r as EpRow).raidDate : (r as GpRow).raidDate;
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
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={draft.raidDate}
                          onChange={(e) => setDraft((d) => ({ ...d, raidDate: e.target.value }))}
                          aria-label="Raid or event date"
                          className={fieldClasses({ size: "sm" })}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-neutral-400">{r.characterName}</td>
                      {props.type === "ep" ? (
                        <>
                          <td className="px-3 py-2">
                            <input
                              value={draft.activityOrTier}
                              onChange={(e) => setDraft((d) => ({ ...d, activityOrTier: e.target.value }))}
                              className={fieldClasses({ size: "sm" })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={draft.zone}
                              onChange={(e) => setDraft((d) => ({ ...d, zone: e.target.value }))}
                              className={fieldClasses({ size: "sm" })}
                              placeholder="Zone"
                            />
                          </td>
                        </>
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
                              placeholder="Bid"
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
                        <input
                          value={draft.note}
                          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                          className={`${fieldClasses({ size: "sm" })} min-w-[10rem]`}
                          placeholder="Note"
                        />
                      </td>
                      <td className="sticky right-0 z-10 bg-neutral-950 px-3 py-2 shadow-[-1px_0_0_0_rgb(38_38_38)]">
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
                      <td className="px-3 py-2 text-neutral-400">{ledgerDate(r.occurredAt, r.source)}</td>
                      <td className="px-3 py-2 text-neutral-500">
                        {linkedEventDate ? (
                          <Link href={`/epgp/raids/${linkedEventDate}`} className="text-accent hover:underline">
                            {linkedEventDate}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium">{r.characterName}</td>
                      {props.type === "ep" ? (
                        <>
                          <td className="px-3 py-2 text-neutral-400">{(r as EpRow).activity}</td>
                          <td className="px-3 py-2 text-neutral-400">{(r as EpRow).zone ?? "—"}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-neutral-400">{(r as GpRow).itemName ?? "—"}</td>
                          <td className="px-3 py-2 text-neutral-400">{(r as GpRow).tier}</td>
                        </>
                      )}
                      <td className={`px-3 py-2 font-medium ${r.points < 0 ? "text-red-400" : "text-emerald-400"}`}>{r.points}</td>
                      <td className="px-3 py-2 text-neutral-500">{r.source}</td>
                      <td className="px-3 py-2 text-neutral-500">{r.enteredByName ?? "—"}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2 text-neutral-500" title={r.note ?? undefined}>
                        {r.note || "—"}
                      </td>
                      {props.canManage && (
                        <td className="sticky right-0 z-10 bg-neutral-950 px-3 py-2 shadow-[-1px_0_0_0_rgb(38_38_38)]">
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
