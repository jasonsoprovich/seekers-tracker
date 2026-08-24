"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { addManualHoldingAction, deleteHoldingAction, updateHoldingAction, type AddHoldingInput } from "@/app/(app)/bank/actions";
import { Button } from "@/components/ui/Button";
import { fieldClasses } from "@/components/ui/Field";
import type { BankHoldingRow } from "@/lib/bank/holdings";

type SortKey = "holderName" | "category" | "itemName" | "quantity" | "status";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "holderName", label: "Holder" },
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

function compare(a: BankHoldingRow, b: BankHoldingRow, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
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

export function BankBrowseTable({ holdings, canManage }: { holdings: BankHoldingRow[]; canManage: boolean }) {
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [holderFilter, setHolderFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("guild_bank");
  const [sortKey, setSortKey] = useState<SortKey>("holderName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddHoldingInput>(emptyAddForm);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editStatus, setEditStatus] = useState<"guild_bank" | "reserved">("guild_bank");
  const [editQuantity, setEditQuantity] = useState("1");
  const [editNote, setEditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Guild-bank-at-a-glance stats — always over the full status=guild_bank
  // set, not the current filter, same reasoning RosterTable's counts don't
  // apply: a KPI that moves every time you adjust a filter isn't useful as
  // a KPI.
  const summary = useMemo(() => {
    const guildBank = holdings.filter((h) => h.status === "guild_bank");
    const totalCurrency = guildBank.filter((h) => h.category === "currency").reduce((sum, h) => sum + h.quantity, 0);
    const itemCount = guildBank.filter((h) => h.category !== "currency").length;
    const holderCount = new Set(guildBank.map((h) => h.holderCharacterId)).size;
    return { totalCurrency, itemCount, holderCount };
  }, [holdings]);

  const holderNames = useMemo(() => [...new Set(holdings.map((h) => h.holderName))].sort(), [holdings]);
  const classRestrictions = useMemo(
    () => [...new Set(holdings.map((h) => h.classRestriction).filter((c): c is string => !!c))].sort(),
    [holdings],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holdings.filter((h) => {
      if (q && !h.itemName.toLowerCase().includes(q) && !h.holderName.toLowerCase().includes(q)) return false;
      if (categoryFilter !== "all" && h.category !== categoryFilter) return false;
      if (holderFilter !== "all" && h.holderName !== holderFilter) return false;
      if (classFilter !== "all" && h.classRestriction !== classFilter) return false;
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      return true;
    });
  }, [holdings, search, categoryFilter, holderFilter, classFilter, statusFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => compare(a, b, sortKey) * (sortDir === "asc" ? 1 : -1));
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
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
    if (!confirm(`Remove "${row.itemName}" from ${row.holderName}'s manual entries?`)) return;
    setPending(true);
    const outcome = await deleteHoldingAction(row.id);
    setPending(false);
    if (outcome.error) {
      alert(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-4">
        <div className="rounded-lg border border-border px-4 py-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Total currency</div>
          <div className="text-lg font-semibold text-emerald-400">{summary.totalCurrency.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-border px-4 py-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Items &amp; spells</div>
          <div className="text-lg font-semibold text-neutral-200">{summary.itemCount.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-border px-4 py-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Holders</div>
          <div className="text-lg font-semibold text-neutral-200">{summary.holderCount}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Search</span>
          <input
            type="text"
            placeholder="Item or holder…"
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
            <option value="currency">Currency</option>
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

        <span className="pb-1.5 text-sm text-neutral-500">
          {sorted.length} of {holdings.length} holding{holdings.length === 1 ? "" : "s"}
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
              <option value="currency">Currency</option>
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
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
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
            {sorted.map((row) => {
              const isEditing = editingId === row.id;
              return (
                <tr key={row.id} className="hover:bg-neutral-900/40">
                  <td className="px-3 py-2 font-medium">{row.holderName}</td>
                  <td className="px-3 py-2 text-neutral-400 capitalize">{row.category}</td>
                  <td className="px-3 py-2">
                    {row.itemName}
                    {row.itemId !== null && <span className="ml-1.5 text-xs text-neutral-600">#{row.itemId}</span>}
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
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 3 + (canManage ? 1 : 0)} className="px-3 py-6 text-center text-neutral-500">
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
