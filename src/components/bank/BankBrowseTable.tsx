"use client";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";

import { addManualHoldingAction, deleteHoldingAction, retireSheetRowsAction, updateHoldingAction, type AddHoldingInput } from "@/app/(app)/bank/actions";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fieldClasses } from "@/components/ui/Field";
import type { BankHoldingRow } from "@/lib/bank/holdings";

type SortKey = "holderName" | "mainName" | "category" | "itemName" | "quantity" | "status";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "holderName", label: "Holder" },
  { key: "mainName", label: "Main" },
  { key: "category", label: "Category" },
  { key: "itemName", label: "Item" },
  { key: "quantity", label: "Qty" },
  { key: "status", label: "Status" },
];

// "General1" (a bag itself) -> "General1"; "General1" slot 3 -> "General1
// slot 3"; a manual entry's sentinel container (holdings.ts's
// manualContainer) -> "Manual entry" rather than a confusing raw
// "Manual slot 1".
function formatLocation(container: string, slotIndex: number): string {
  if (container === "Manual") return "Manual entry";
  return slotIndex === 0 ? container : `${container} slot ${slotIndex}`;
}

export type LastImportRow = {
  characterId: number;
  sourceFile: string | null;
  rowCount: number;
  reportsSharedBank: boolean;
  uploadedByName: string | null;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const emptyAddForm: AddHoldingInput = {
  holderName: "",
  category: "item",
  itemName: "",
  itemId: "",
  quantity: "1",
  classRestriction: "",
  status: "guild_bank",
  note: "",
};

// ---------------------------------------------------------------------
// Grouping (2026-09-25 officer feedback): non-stacking items (mostly
// spells, per the guild's screenshot — a spell can't stack in-game, so
// each copy is its own row/slot) showed as many separate rows for the
// same item. Group them into one row with a summed quantity, expandable
// to the individual slots/holders since a duplicate spell etc. may be
// held by multiple mules. Grouped by (category, itemId) when an item ID
// is known — the reliable join key, same reasoning bank_holdings.itemId's
// own schema comment gives — falling back to a lowercased item-name match
// for sheet/manual rows that never captured one.
// ---------------------------------------------------------------------

type BankGroup = {
  key: string;
  category: "item" | "spell";
  itemName: string;
  itemId: number | null;
  noDrop: boolean;
  quantity: number;
  holderNames: string[];
  mainNames: string[];
  status: "guild_bank" | "reserved";
  statusMixed: boolean;
  classRestriction: string | null;
  classMixed: boolean;
  fromSheetAny: boolean;
  rows: BankHoldingRow[];
};

function groupKey(row: BankHoldingRow): string {
  return row.itemId !== null ? `${row.category}::id:${row.itemId}` : `${row.category}::name:${row.itemName.toLowerCase()}`;
}

function buildGroups(rows: BankHoldingRow[]): BankGroup[] {
  const map = new Map<string, BankGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        category: row.category,
        itemName: row.itemName,
        itemId: row.itemId,
        noDrop: row.noDrop,
        quantity: 0,
        holderNames: [],
        mainNames: [],
        status: row.status,
        statusMixed: false,
        classRestriction: row.classRestriction,
        classMixed: false,
        fromSheetAny: false,
        rows: [],
      };
      map.set(key, g);
    }
    g.quantity += row.quantity;
    if (!g.holderNames.includes(row.holderName)) g.holderNames.push(row.holderName);
    if (row.ownerMainName && !g.mainNames.includes(row.ownerMainName)) g.mainNames.push(row.ownerMainName);
    if (g.status !== row.status) g.statusMixed = true;
    if (g.classRestriction !== row.classRestriction) g.classMixed = true;
    if (row.fromSheet) g.fromSheetAny = true;
    g.rows.push(row);
  }
  return [...map.values()];
}

function multiDisplay(names: string[]): string {
  if (names.length === 0) return "—";
  const sorted = [...names].sort();
  return sorted.length === 1 ? sorted[0] : `${sorted[0]} +${sorted.length - 1}`;
}

function groupSortValue(g: BankGroup, key: SortKey): string | number {
  switch (key) {
    case "holderName":
      return [...g.holderNames].sort()[0] ?? "";
    case "mainName":
      return [...g.mainNames].sort()[0] ?? "";
    case "category":
      return g.category;
    case "itemName":
      return g.itemName;
    case "quantity":
      return g.quantity;
    case "status":
      return g.statusMixed ? "mixed" : g.status;
  }
}

function compareGroups(a: BankGroup, b: BankGroup, key: SortKey): number {
  const av = groupSortValue(a, key);
  const bv = groupSortValue(b, key);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

export function BankBrowseTable({
  holdings,
  canManage,
  lastImports,
}: {
  holdings: BankHoldingRow[];
  canManage: boolean;
  lastImports: LastImportRow[];
}) {
  const router = useRouter();
  const confirm = useConfirm();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [holderFilter, setHolderFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("guild_bank");
  const [hideNoDrop, setHideNoDrop] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("holderName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddHoldingInput>(emptyAddForm);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editStatus, setEditStatus] = useState<"guild_bank" | "reserved">("guild_bank");
  const [editQuantity, setEditQuantity] = useState("1");
  const [editNote, setEditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [retiringId, setRetiringId] = useState<number | "all" | null>(null);

  // Guild-bank-at-a-glance stats — always over the full status=guild_bank
  // set, not the current filter, same reasoning RosterTable's counts don't
  // apply: a KPI that moves every time you adjust a filter isn't useful as
  // a KPI. Currency is gone entirely (2026-09-25) — no card for it anymore.
  const summary = useMemo(() => {
    const guildBank = holdings.filter((h) => h.status === "guild_bank");
    const holderCount = new Set(guildBank.map((h) => h.holderCharacterId)).size;
    return { itemCount: guildBank.length, holderCount };
  }, [holdings]);

  const holderNames = useMemo(() => [...new Set(holdings.map((h) => h.holderName))].sort(), [holdings]);
  const nameByCharacterId = useMemo(() => {
    const map = new Map<number, string>();
    for (const h of holdings) map.set(h.holderCharacterId, h.holderName);
    return map;
  }, [holdings]);
  const sortedLastImports = useMemo(
    () => [...lastImports].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [lastImports],
  );
  const classRestrictions = useMemo(
    () => [...new Set(holdings.map((h) => h.classRestriction).filter((c): c is string => !!c))].sort(),
    [holdings],
  );

  // 2026-09-25 sheet-to-sync transition: holders that still have a sheet-
  // imported row (source='import', importId null — see holdings.ts's
  // fromSheet). A holder's first real sync already clears these
  // automatically; this list is for the ones that haven't synced yet.
  const sheetHolders = useMemo(() => {
    const map = new Map<number, { characterId: number; name: string; count: number }>();
    for (const h of holdings) {
      if (!h.fromSheet) continue;
      const entry = map.get(h.holderCharacterId) ?? { characterId: h.holderCharacterId, name: h.holderName, count: 0 };
      entry.count += 1;
      map.set(h.holderCharacterId, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [holdings]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holdings.filter((h) => {
      if (q && !h.itemName.toLowerCase().includes(q) && !h.holderName.toLowerCase().includes(q) && !(h.ownerMainName ?? "").toLowerCase().includes(q)) {
        return false;
      }
      if (categoryFilter !== "all" && h.category !== categoryFilter) return false;
      if (holderFilter !== "all" && h.holderName !== holderFilter) return false;
      if (classFilter !== "all" && h.classRestriction !== classFilter) return false;
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      if (hideNoDrop && h.noDrop) return false;
      return true;
    });
  }, [holdings, search, categoryFilter, holderFilter, classFilter, statusFilter, hideNoDrop]);

  const groups = useMemo(() => buildGroups(filteredRows), [filteredRows]);
  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => compareGroups(a, b, sortKey) * (sortDir === "asc" ? 1 : -1));
  }, [groups, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onAddSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setAddError(null);
    const outcome = await addManualHoldingAction(addForm);
    setPending(false);
    if (outcome.error) {
      setAddError(outcome.error);
      return;
    }
    setAddForm(emptyAddForm);
    setAddOpen(false);
    router.refresh();
  }

  function startEdit(row: BankHoldingRow) {
    setEditingId(row.id);
    setEditStatus(row.status);
    setEditQuantity(String(row.quantity));
    setEditNote(row.note ?? "");
    setEditError(null);
  }

  async function saveEdit(id: number) {
    setPending(true);
    setEditError(null);
    const outcome = await updateHoldingAction(id, { status: editStatus, quantity: editQuantity, note: editNote });
    setPending(false);
    if (outcome.error) {
      setEditError(outcome.error);
      return;
    }
    setEditingId(null);
    router.refresh();
  }

  async function onDelete(row: BankHoldingRow) {
    const ok = await confirm({
      title: "Remove holding?",
      message: `Remove "${row.itemName}" from ${row.holderName}'s manual entries?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setPending(true);
    const outcome = await deleteHoldingAction(row.id);
    setPending(false);
    if (outcome.error) {
      alert(outcome.error);
      return;
    }
    router.refresh();
  }

  async function onRetire(target: number | "all", label: string) {
    const ok = await confirm({
      title: "Retire sheet rows?",
      message:
        target === "all"
          ? `Remove every remaining sheet-imported bank row (${sheetHolders.reduce((s, h) => s + h.count, 0)} row(s) across ${sheetHolders.length} holder(s))? This can't be undone, though a re-import of the old sheet data can recreate them if needed.`
          : `Remove ${label}'s sheet-imported bank rows? This can't be undone — do this once ${label} has synced from the app, or if ${label} will never be synced.`,
      confirmLabel: "Retire",
      danger: true,
    });
    if (!ok) return;
    setRetiringId(target);
    const outcome = await retireSheetRowsAction(target);
    setRetiringId(null);
    if (outcome.error) {
      alert(outcome.error);
      return;
    }
    router.refresh();
  }

  function renderRowCells(row: BankHoldingRow, isEditing: boolean) {
    return (
      <>
        <td className="px-3 py-2 font-medium">{row.holderName}</td>
        <td className="px-3 py-2 text-neutral-400">{row.ownerMainName ?? "—"}</td>
        <td className="px-3 py-2 text-neutral-400 capitalize">{row.category}</td>
        <td className="px-3 py-2">
          {row.itemName}
          {row.itemId !== null && <span className="ml-1.5 text-xs text-neutral-600">#{row.itemId}</span>}
          {row.noDrop && (
            <span className="ml-1.5 rounded-full bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
              No drop
            </span>
          )}
          {row.fromSheet && (
            <span className="ml-1.5 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
              Sheet
            </span>
          )}
        </td>
        <td className="px-3 py-2">
          {isEditing ? (
            <input
              value={editQuantity}
              onChange={(e) => setEditQuantity(e.target.value)}
              inputMode="numeric"
              className={`${fieldClasses({ size: "sm" })} w-16`}
            />
          ) : (
            row.quantity.toLocaleString()
          )}
        </td>
        <td className="px-3 py-2">
          {isEditing ? (
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as "guild_bank" | "reserved")}
              className={fieldClasses({ size: "sm" })}
            >
              <option value="guild_bank">Guild bank</option>
              <option value="reserved">Reserved</option>
            </select>
          ) : row.status === "guild_bank" ? (
            <span className="text-emerald-400">Guild bank</span>
          ) : (
            <span className="text-neutral-500">Reserved</span>
          )}
        </td>
        <td className="px-3 py-2 text-neutral-500">{formatLocation(row.container, row.slotIndex)}</td>
        <td className="px-3 py-2 text-neutral-500">{row.classRestriction ?? "—"}</td>
        <td className="px-3 py-2 text-neutral-500">
          {isEditing ? (
            <input value={editNote} onChange={(e) => setEditNote(e.target.value)} className={`${fieldClasses({ size: "sm" })} w-32`} />
          ) : (
            (row.note ?? "—")
          )}
        </td>
        {canManage && (
          <td className="px-3 py-2">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={() => saveEdit(row.id)} disabled={pending}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => startEdit(row)} className="text-neutral-400 hover:text-neutral-200">
                  Edit
                </button>
                {row.source === "manual" && (
                  <button type="button" onClick={() => onDelete(row)} className="text-red-500/80 hover:text-red-400">
                    Delete
                  </button>
                )}
              </div>
            )}
            {isEditing && editError && <div className="mt-1 text-xs text-red-400">{editError}</div>}
          </td>
        )}
      </>
    );
  }

  const totalColumns = 1 + COLUMNS.length + 3 + (canManage ? 1 : 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-4">
        <div className="rounded-lg border border-border px-4 py-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Items &amp; spells</div>
          <div className="text-lg font-semibold text-neutral-200">{summary.itemCount.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-border px-4 py-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Holders</div>
          <div className="text-lg font-semibold text-neutral-200">{summary.holderCount}</div>
        </div>
      </div>

      {sortedLastImports.length > 0 && (
        <details className="mb-4 rounded-lg border border-border px-4 py-2 text-sm">
          <summary className="cursor-pointer select-none text-neutral-400">
            Synced from {sortedLastImports.length} character{sortedLastImports.length === 1 ? "" : "s"}&apos; inventory exports
          </summary>
          <ul className="mt-2 space-y-1 text-neutral-500">
            {sortedLastImports.map((info) => (
              <li key={info.characterId}>
                <span className="text-neutral-300">{nameByCharacterId.get(info.characterId) ?? `#${info.characterId}`}</span> — {info.rowCount} row
                {info.rowCount === 1 ? "" : "s"}
                {info.reportsSharedBank && <span className="text-amber-400/80"> · shared bank</span>}, synced {timeAgo(info.createdAt)} by{" "}
                {info.uploadedByName ?? "an officer"}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canManage && sheetHolders.length > 0 && (
        <details className="mb-4 rounded-lg border border-border px-4 py-2 text-sm">
          <summary className="cursor-pointer select-none text-neutral-400">
            {sheetHolders.length} holder{sheetHolders.length === 1 ? "" : "s"} still have old sheet-imported rows
          </summary>
          <ul className="mt-2 space-y-1.5 text-neutral-500">
            {sheetHolders.map((h) => (
              <li key={h.characterId} className="flex items-center gap-2">
                <span className="text-neutral-300">{h.name}</span> — {h.count} row{h.count === 1 ? "" : "s"}
                <button
                  type="button"
                  disabled={retiringId !== null}
                  onClick={() => onRetire(h.characterId, h.name)}
                  className="text-red-500/80 hover:text-red-400 disabled:opacity-50"
                >
                  Retire
                </button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="outline" className="mt-3" disabled={retiringId !== null} onClick={() => onRetire("all", "all holders")}>
            {retiringId === "all" ? "Retiring…" : "Retire all remaining sheet rows"}
          </Button>
        </details>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Item, holder, or main…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClasses({ size: "sm" })} w-48`}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Category</span>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All categories</option>
            <option value="item">Item</option>
            <option value="spell">Spell</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Mule / holder</span>
          <select value={holderFilter} onChange={(e) => setHolderFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All holders</option>
            {holderNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Class</span>
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="all">All classes</option>
            {classRestrictions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={fieldClasses({ size: "sm" })}>
            <option value="guild_bank">Guild bank only</option>
            <option value="all">All statuses</option>
            <option value="reserved">Reserved only</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 pb-1.5 text-sm text-neutral-400">
          <input type="checkbox" checked={hideNoDrop} onChange={(e) => setHideNoDrop(e.target.checked)} />
          Hide NO DROP
        </label>

        <span className="pb-1.5 text-sm text-neutral-500">
          {sortedGroups.length} row{sortedGroups.length === 1 ? "" : "s"} ({filteredRows.length} of {holdings.length} holding
          {holdings.length === 1 ? "" : "s"})
        </span>

        {canManage && (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => setAddOpen((v) => !v)}>
            {addOpen ? "Cancel" : "+ Add item"}
          </Button>
        )}
      </div>

      {canManage && addOpen && (
        <form onSubmit={onAddSubmit} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-border p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Holder character</span>
            <input
              value={addForm.holderName}
              onChange={(e) => setAddForm({ ...addForm, holderName: e.target.value })}
              placeholder="Character name"
              required
              className={`${fieldClasses({ size: "sm" })} w-36`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Category</span>
            <select
              value={addForm.category}
              onChange={(e) => setAddForm({ ...addForm, category: e.target.value as AddHoldingInput["category"] })}
              className={fieldClasses({ size: "sm" })}
            >
              <option value="item">Item</option>
              <option value="spell">Spell</option>
            </select>
          </label>
          <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-sm">
            <span className="text-neutral-400">Item name</span>
            <input
              value={addForm.itemName}
              onChange={(e) => setAddForm({ ...addForm, itemName: e.target.value })}
              required
              className={fieldClasses({ size: "sm" })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Item ID (optional)</span>
            <input
              value={addForm.itemId}
              onChange={(e) => setAddForm({ ...addForm, itemId: e.target.value })}
              inputMode="numeric"
              className={`${fieldClasses({ size: "sm" })} w-24`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Qty</span>
            <input
              value={addForm.quantity}
              onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
              inputMode="numeric"
              className={`${fieldClasses({ size: "sm" })} w-20`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Class restriction (optional)</span>
            <input
              value={addForm.classRestriction}
              onChange={(e) => setAddForm({ ...addForm, classRestriction: e.target.value })}
              placeholder="e.g. WAR PAL"
              className={`${fieldClasses({ size: "sm" })} w-32`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Status</span>
            <select
              value={addForm.status}
              onChange={(e) => setAddForm({ ...addForm, status: e.target.value as AddHoldingInput["status"] })}
              className={fieldClasses({ size: "sm" })}
            >
              <option value="guild_bank">Guild bank</option>
              <option value="reserved">Reserved</option>
            </select>
          </label>
          <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-sm">
            <span className="text-neutral-400">Note (optional)</span>
            <input
              value={addForm.note}
              onChange={(e) => setAddForm({ ...addForm, note: e.target.value })}
              className={fieldClasses({ size: "sm" })}
            />
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Add"}
          </Button>
          {addError && <p className="w-full text-sm text-red-400">{addError}</p>}
        </form>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-2 py-2" />
              {COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium">
                  <button type="button" onClick={() => toggleSort(col.key)} className="flex items-center gap-1 hover:text-neutral-200">
                    {col.label}
                    {sortKey === col.key && <span className="text-neutral-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Location</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Note</th>
              {canManage && <th className="px-3 py-2 font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedGroups.map((g) => {
              if (g.rows.length === 1) {
                const row = g.rows[0];
                const isEditing = editingId === row.id;
                return (
                  <tr key={g.key} className="hover:bg-neutral-900/40">
                    <td className="px-2 py-2" />
                    {renderRowCells(row, isEditing)}
                  </tr>
                );
              }

              const isOpen = expanded.has(g.key);
              return (
                <Fragment key={g.key}>
                  <tr className="bg-neutral-950/30 hover:bg-neutral-900/40">
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => toggleExpand(g.key)}
                        className="text-neutral-500 hover:text-neutral-200"
                        aria-label={isOpen ? "Collapse" : "Expand"}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-medium">{multiDisplay(g.holderNames)}</td>
                    <td className="px-3 py-2 text-neutral-400">{multiDisplay(g.mainNames)}</td>
                    <td className="px-3 py-2 text-neutral-400 capitalize">{g.category}</td>
                    <td className="px-3 py-2">
                      {g.itemName}
                      {g.itemId !== null && <span className="ml-1.5 text-xs text-neutral-600">#{g.itemId}</span>}
                      <span className="ml-1.5 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">×{g.rows.length}</span>
                      {g.noDrop && (
                        <span className="ml-1.5 rounded-full bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
                          No drop
                        </span>
                      )}
                      {g.fromSheetAny && (
                        <span className="ml-1.5 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                          Sheet
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{g.quantity.toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {g.statusMixed ? (
                        <span className="text-amber-400">Mixed</span>
                      ) : g.status === "guild_bank" ? (
                        <span className="text-emerald-400">Guild bank</span>
                      ) : (
                        <span className="text-neutral-500">Reserved</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{g.rows.length} slots</td>
                    <td className="px-3 py-2 text-neutral-500">{g.classMixed ? "mixed" : (g.classRestriction ?? "—")}</td>
                    <td className="px-3 py-2 text-neutral-500">—</td>
                    {canManage && <td className="px-3 py-2 text-neutral-600">expand to edit</td>}
                  </tr>
                  {isOpen &&
                    g.rows.map((row) => {
                      const isEditing = editingId === row.id;
                      return (
                        <tr key={row.id} className="bg-neutral-950/10 text-neutral-300">
                          <td className="px-2 py-2" />
                          {renderRowCells(row, isEditing)}
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
            {sortedGroups.length === 0 && (
              <tr>
                <td colSpan={totalColumns} className="px-3 py-6 text-center text-neutral-500">
                  No holdings match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
