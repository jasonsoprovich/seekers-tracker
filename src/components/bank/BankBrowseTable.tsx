"use client";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";

import { addManualHoldingAction, deleteHoldingAction, removeUnverifiedHoldingAction, updateHoldingAction, type AddHoldingInput } from "@/app/(app)/bank/actions";
import { ItemLink } from "@/components/items/ItemLink";
import { Button } from "@/components/ui/Button";
import { useConfirmWith } from "@/components/ui/ConfirmDialog";
import { fieldClasses } from "@/components/ui/Field";
import { BANK_MANUAL_ADD_ENABLED } from "@/lib/bank/constants";
import type { BankHoldingRow } from "@/lib/bank/holdings";
import { normalizeBankItemName } from "@/lib/bank/item-name";

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
// "Manual slot 1"; a sheet-migrated row's synthetic "Sheet" container
// (migration 0053) shows its ORIGINAL sheet position via legacyLocation
// instead of the meaningless synthetic slot number — a member reading the
// Location column shouldn't have to know "Sheet" is an internal bookkeeping
// container at all.
function formatLocation(container: string, slotIndex: number, legacyLocation: string | null): string {
  if (container === "Sheet") return legacyLocation ?? "Sheet (no recorded location)";
  if (container === "Manual") return "Manual entry";
  return slotIndex === 0 ? container : `${container} slot ${slotIndex}`;
}

// Officer-only unverified-state badge (BankHoldingRow.unverifiedState) —
// members see every row exactly the same regardless of sync status, per
// Jason's own transparency concern: nothing should look like it vanished.
const UNVERIFIED_BADGE: Record<Exclude<BankHoldingRow["unverifiedState"], null>, { label: string; className: string }> = {
  sheet: { label: "Sheet", className: "bg-neutral-800 text-neutral-500" },
  manual: { label: "Unverified", className: "bg-neutral-800 text-neutral-500" },
  not_found: { label: "Needs review", className: "bg-amber-950/50 text-amber-400" },
};

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
  auditNote: "",
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
  // Counts, not booleans — a group spanning several holders (e.g. 3
  // identical spells) can have some rows verified and some not; the
  // group-row badge shows "needs review" if ANY row does, "unverified" if
  // any pending-but-not-flagged row does, otherwise nothing.
  unverifiedCount: number;
  notFoundCount: number;
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
        unverifiedCount: 0,
        notFoundCount: 0,
        rows: [],
      };
      map.set(key, g);
    }
    g.quantity += row.quantity;
    if (!g.holderNames.includes(row.holderName)) g.holderNames.push(row.holderName);
    if (row.ownerMainName && !g.mainNames.includes(row.ownerMainName)) g.mainNames.push(row.ownerMainName);
    if (g.status !== row.status) g.statusMixed = true;
    if (g.classRestriction !== row.classRestriction) g.classMixed = true;
    if (row.unverifiedState !== null) g.unverifiedCount += 1;
    if (row.unverifiedState === "not_found") g.notFoundCount += 1;
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
  const confirmWith = useConfirmWith();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [holderFilter, setHolderFilter] = useState<string>("all");
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
  const [editAuditNote, setEditAuditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | string | null>(null);
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);

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
  // 2026-09-27 unverified-item tracking (was "sheetHolders"/Retire —
  // holdings.ts's BankHoldingRow.unverifiedState). Officer-only: per-holder
  // progress toward full verification, and the "needs review" list of
  // items a real sync couldn't find. A holder's first real sync resolves
  // most of these automatically (src/lib/bank/sync.ts's
  // reconcileUnverified); this panel is for what's left.
  const verification = useMemo(() => {
    const total = holdings.length;
    const unverified = holdings.filter((h) => h.unverifiedState !== null);
    const notFound = holdings.filter((h) => h.unverifiedState === "not_found");

    const syncedIds = new Set(lastImports.map((i) => i.characterId));
    const byHolder = new Map<number, { characterId: number; name: string; unverified: number; notFound: number; synced: boolean }>();
    for (const h of unverified) {
      const entry = byHolder.get(h.holderCharacterId) ?? {
        characterId: h.holderCharacterId,
        name: h.holderName,
        unverified: 0,
        notFound: 0,
        synced: syncedIds.has(h.holderCharacterId),
      };
      entry.unverified += 1;
      if (h.unverifiedState === "not_found") entry.notFound += 1;
      byHolder.set(h.holderCharacterId, entry);
    }
    const holders = [...byHolder.values()].sort((a, b) => b.notFound - a.notFound || b.unverified - a.unverified || a.name.localeCompare(b.name));
    // 2026-10-21: split by what an officer should actually do. Only a synced
    // holder's not-found rows need a decision; a synced holder's other rows
    // sit in bags not flagged yet (flag + re-sync), and a never-synced
    // holder's rows just wait for its first sync — no remove-all button
    // there, it would wipe real inventory nobody has checked.
    const waitingOnBags = holders.filter((h) => h.synced && h.unverified > h.notFound);
    const neverSynced = holders.filter((h) => !h.synced);

    // For each not-found item, whether the same item name already exists
    // as a VERIFIED row on a different holder — a hint that it may just be
    // sitting somewhere else in the guild's bank already, computed
    // client-side from rows already loaded (no extra query).
    const verifiedNamesByHolder = new Map<string, Set<number>>();
    for (const h of holdings) {
      if (h.unverifiedState !== null) continue;
      const key = normalizeBankItemName(h.itemName);
      const set = verifiedNamesByHolder.get(key) ?? new Set<number>();
      set.add(h.holderCharacterId);
      verifiedNamesByHolder.set(key, set);
    }
    // Not-found rows grouped per holder, then per item name — one line for
    // "Brell's Mountainous Barrier ×3" instead of three near-identical rows.
    type ReviewGroup = { key: string; itemName: string; itemId: number | null; quantity: number; ids: number[]; locations: string[]; alsoOn: string[] };
    const reviewByHolder = new Map<number, { characterId: number; name: string; ids: number[]; groups: Map<string, ReviewGroup> }>();
    for (const h of notFound) {
      const holder = reviewByHolder.get(h.holderCharacterId) ?? { characterId: h.holderCharacterId, name: h.holderName, ids: [] as number[], groups: new Map<string, ReviewGroup>() };
      const key = normalizeBankItemName(h.itemName);
      const group = holder.groups.get(key) ?? {
        key,
        itemName: h.itemName,
        itemId: h.itemId,
        quantity: 0,
        ids: [],
        locations: [],
        alsoOn: [...(verifiedNamesByHolder.get(key) ?? [])].filter((id) => id !== h.holderCharacterId).map((id) => nameByCharacterId.get(id) ?? `#${id}`),
      };
      group.quantity += h.quantity;
      group.ids.push(h.id);
      group.locations.push(formatLocation(h.container, h.slotIndex, h.legacyLocation));
      holder.groups.set(key, group);
      holder.ids.push(h.id);
      reviewByHolder.set(h.holderCharacterId, holder);
    }
    const needsReview = [...reviewByHolder.values()]
      .map((h) => ({ ...h, groups: [...h.groups.values()].sort((a, b) => a.itemName.localeCompare(b.itemName)) }))
      .sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));

    return {
      total,
      verifiedCount: total - unverified.length,
      unverifiedCount: unverified.length,
      notFoundCount: notFound.length,
      needsReview,
      waitingOnBags,
      neverSynced,
    };
  }, [holdings, nameByCharacterId, lastImports]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holdings.filter((h) => {
      if (q && !h.itemName.toLowerCase().includes(q) && !h.holderName.toLowerCase().includes(q) && !(h.ownerMainName ?? "").toLowerCase().includes(q)) {
        return false;
      }
      if (categoryFilter !== "all" && h.category !== categoryFilter) return false;
      if (holderFilter !== "all" && h.holderName !== holderFilter) return false;
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      if (hideNoDrop && h.noDrop) return false;
      if (unverifiedOnly && h.unverifiedState === null) return false;
      return true;
    });
  }, [holdings, search, categoryFilter, holderFilter, statusFilter, hideNoDrop, unverifiedOnly]);

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
    setEditAuditNote("");
    setEditError(null);
  }

  async function saveEdit(id: number) {
    setPending(true);
    setEditError(null);
    const outcome = await updateHoldingAction(id, { status: editStatus, quantity: editQuantity, note: editNote, auditNote: editAuditNote });
    setPending(false);
    if (outcome.error) {
      setEditError(outcome.error);
      return;
    }
    setEditingId(null);
    router.refresh();
  }

  async function onDelete(row: BankHoldingRow) {
    const result = await confirmWith({
      title: "Remove holding?",
      message: `Remove "${row.itemName}" from ${row.holderName}'s manual entries?`,
      confirmLabel: "Remove",
      danger: true,
      textInput: { label: "Note (optional) — e.g. who received this item", placeholder: "Given to…" },
    });
    if (!result.ok) return;
    setPending(true);
    const outcome = await deleteHoldingAction(row.id, result.note || undefined);
    setPending(false);
    if (outcome.error) {
      alert(outcome.error);
      return;
    }
    router.refresh();
  }

  // 2026-09-27 (was onRetire): removes an unverified sheet/manual row —
  // one item, or every remaining unverified row for one holder — for
  // something genuinely gone rather than just unsynced yet. Always
  // requires a note (server-enforced; removeUnverifiedHoldingAction
  // refuses a blank one) so the audit trail keeps saying WHY.
  async function onRemoveUnverified(
    target: { kind: "row"; id: number } | { kind: "rows"; ids: number[] } | { kind: "holder"; holderCharacterId: number },
    label: string,
    key: number | string = target.kind === "row" ? target.id : target.kind === "holder" ? `holder:${target.holderCharacterId}` : `rows:${label}`,
  ): Promise<boolean> {
    const result = await confirmWith({
      title: "Remove from the guild bank?",
      message:
        target.kind === "row"
          ? `Remove "${label}"? This can't be undone. Only do this for an item that's genuinely gone — not just unsynced yet.`
          : target.kind === "rows"
            ? `Remove ${label}? These are old sheet entries the last sync looked for and didn't find. This can't be undone, and the note is saved to the bank's Audit tab.`
            : `Remove all of ${label}'s old sheet rows? Only do this if ${label} will never be synced from the officer app — otherwise sync it first and most rows confirm themselves.`,
      confirmLabel: "Remove",
      danger: true,
      textInput: { label: "Note — who received it, or why it's gone", placeholder: "Given to…" },
    });
    if (!result.ok) return false;
    setRemovingId(key);
    const outcome = await removeUnverifiedHoldingAction(target, result.note ?? "");
    setRemovingId(null);
    if (outcome.error) {
      alert(outcome.error);
      return false;
    }
    router.refresh();
    return true;
  }

  // Wraps onRemoveUnverified for the inline edit-row Remove button — closes
  // the edit row on success (same as saveEdit) so a removed row doesn't sit
  // half-open in edit mode after it's gone.
  async function removeRowWhileEditing(row: BankHoldingRow) {
    const ok = await onRemoveUnverified({ kind: "row", id: row.id }, row.itemName);
    if (ok && editingId === row.id) setEditingId(null);
  }

  // Actions column background while it's pinned via `sticky right-0` (see
  // below) — a sticky cell needs its OWN opaque background, not just its
  // row's, since it has to visually cover whatever scrolls underneath it.
  // Matches each row context's own (translucent) row background as closely
  // as a solid color can.
  const actionsCellBg = (isNested: boolean) => (isNested ? "bg-neutral-900" : "bg-neutral-950");

  function renderRowCells(row: BankHoldingRow, isEditing: boolean, isNested = false) {
    return (
      <>
        <td className={`py-2 font-medium ${isNested ? "border-l-2 border-l-emerald-700/50 pl-6 pr-3" : "px-3"}`}>{row.holderName}</td>
        <td className="px-3 py-2 text-neutral-400">{row.ownerMainName ?? "—"}</td>
        <td className="px-3 py-2 text-neutral-400 capitalize">{row.category}</td>
        <td className="px-3 py-2">
          <ItemLink name={row.itemName} itemId={row.itemId} />
          {row.itemId !== null && <span className="ml-1.5 text-xs text-neutral-600">#{row.itemId}</span>}
          {row.noDrop && (
            <span className="ml-1.5 rounded-full bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
              No drop
            </span>
          )}
          {canManage && row.unverifiedState !== null && (
            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${UNVERIFIED_BADGE[row.unverifiedState].className}`}>
              {UNVERIFIED_BADGE[row.unverifiedState].label}
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
        <td className="px-3 py-2 text-neutral-500">{formatLocation(row.container, row.slotIndex, row.legacyLocation)}</td>
        <td className="px-3 py-2 text-neutral-500">
          {isEditing ? (
            <input value={editNote} onChange={(e) => setEditNote(e.target.value)} className={`${fieldClasses({ size: "sm" })} w-32`} />
          ) : (
            (row.note ?? "—")
          )}
        </td>
        {canManage && (
          <td className={`sticky right-0 z-10 px-3 py-2 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.6)] ${actionsCellBg(isNested)}`}>
            {isEditing ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={editAuditNote}
                  onChange={(e) => setEditAuditNote(e.target.value)}
                  placeholder="Audit note (optional)"
                  title="Context for this edit's audit-log entry — e.g. who donated it"
                  className={`${fieldClasses({ size: "sm" })} w-28`}
                />
                <Button type="button" size="sm" onClick={() => saveEdit(row.id)} disabled={pending}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
                {/* Unverified rows only (sheet-migrated / manual rows a real
                    sync hasn't confirmed yet) — a verified holding stays
                    protected from manual deletion since a sync keeps it
                    accurate on its own. Reuses the same required-note,
                    audit-logged path the Verification progress panel above
                    already calls, just reachable without leaving this row. */}
                {row.unverifiedState !== null && (
                  <button
                    type="button"
                    disabled={removingId !== null}
                    onClick={() => removeRowWhileEditing(row)}
                    className="text-red-500/80 hover:text-red-400 disabled:opacity-50"
                  >
                    {removingId === row.id ? "Removing…" : "Remove"}
                  </button>
                )}
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

  const totalColumns = 1 + COLUMNS.length + 2 + (canManage ? 1 : 0);

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

      {canManage && verification.unverifiedCount > 0 && (
        <details className="mb-4 rounded-lg border border-border px-4 py-2 text-sm" open={verification.notFoundCount > 0}>
          <summary className="cursor-pointer select-none text-neutral-400">
            Old sheet cleanup — {verification.verifiedCount.toLocaleString()} of {verification.total.toLocaleString()} bank items confirmed
            {verification.notFoundCount > 0 && (
              <span className="ml-2 text-amber-400">
                · {verification.notFoundCount} need{verification.notFoundCount === 1 ? "s" : ""} a decision
              </span>
            )}
          </summary>

          <p className="mt-3 max-w-3xl text-neutral-400">
            Everything from the old Google Sheet starts out unconfirmed. When a character syncs from the officer app, every sheet entry
            that&apos;s really on that character confirms itself. You only need to act on the first list below. Everything else clears up as
            characters get synced.
          </p>

          {verification.needsReview.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs uppercase tracking-wide text-amber-400/90">1 · Needs a decision</div>
              <p className="mb-3 max-w-3xl text-neutral-500">
                The character synced and these weren&apos;t in the bag the sheet listed, or anywhere else in its synced bags. Usually they were
                handed out, used or vendored and the sheet never caught up. If one is actually in a bag that isn&apos;t flagged as guild yet,
                flag that bag in the officer app and sync again instead. Otherwise remove it with a short note.
              </p>
              <div className="space-y-4">
                {verification.needsReview.map((h) => (
                  <div key={h.characterId}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium text-neutral-200">{h.name}</span>
                      <span className="text-neutral-500">
                        {h.ids.length} not found
                      </span>
                      <button
                        type="button"
                        disabled={removingId !== null}
                        onClick={() =>
                          onRemoveUnverified({ kind: "rows", ids: h.ids }, `all ${h.ids.length} of ${h.name}'s not-found item${h.ids.length === 1 ? "" : "s"}`, `review:${h.characterId}`)
                        }
                        className="text-red-500/80 hover:text-red-400 disabled:opacity-50"
                      >
                        {removingId === `review:${h.characterId}` ? "Removing…" : `Remove all ${h.ids.length}…`}
                      </button>
                    </div>
                    <ul className="space-y-1 border-l border-border pl-3">
                      {h.groups.map((g) => (
                        <li key={g.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-400">
                          <span className="text-neutral-200">
                            <ItemLink name={g.itemName} itemId={g.itemId} />
                          </span>
                          <span className="text-neutral-500">
                            ×{g.quantity} · sheet: {g.locations.join(", ")}
                          </span>
                          {g.alsoOn.length > 0 && <span className="text-sky-400/80">also on {g.alsoOn.join(", ")}</span>}
                          <button
                            type="button"
                            disabled={removingId !== null}
                            onClick={() =>
                              g.ids.length === 1
                                ? onRemoveUnverified({ kind: "row", id: g.ids[0] }, g.itemName)
                                : onRemoveUnverified({ kind: "rows", ids: g.ids }, `${g.itemName} ×${g.quantity} from ${h.name}`, `group:${h.characterId}:${g.key}`)
                            }
                            className="text-red-500/80 hover:text-red-400 disabled:opacity-50"
                          >
                            {removingId === g.ids[0] || removingId === `group:${h.characterId}:${g.key}` ? "Removing…" : "Remove…"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {verification.waitingOnBags.length > 0 && (
            <div className="mt-5 border-t border-border pt-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">2 · Synced, but some bags aren&apos;t flagged yet</div>
              <p className="mb-2 max-w-3xl text-neutral-500">
                These sheet entries are listed in bags that weren&apos;t part of the sync. Nothing to remove. In the officer app, flag the bags it
                suggests (&ldquo;Flag all suggested bags&rdquo;) and sync again.
              </p>
              <ul className="space-y-1 text-neutral-400">
                {verification.waitingOnBags.map((h) => (
                  <li key={h.characterId}>
                    <span className="text-neutral-200">{h.name}</span> — {h.unverified - h.notFound} entr{h.unverified - h.notFound === 1 ? "y" : "ies"}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {verification.neverSynced.length > 0 && (
            <div className="mt-5 border-t border-border pt-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">3 · Not synced yet</div>
              <p className="mb-2 max-w-3xl text-neutral-500">
                Nothing to do here on the website. Log in to each one, run <code className="text-neutral-300">/outputfile inventory</code>, and sync
                it from the officer app.
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-neutral-400">
                {verification.neverSynced.map((h) => (
                  <li key={h.characterId}>
                    <span className="text-neutral-200">{h.name}</span> {h.unverified}
                  </li>
                ))}
              </ul>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer select-none text-neutral-500">A character that will never be synced?</summary>
                <p className="mt-2 text-neutral-500">
                  Only if the character is gone for good or emptied (deleted, items moved elsewhere). This removes every one of its old sheet
                  entries.
                </p>
                <ul className="mt-2 space-y-1">
                  {verification.neverSynced.map((h) => (
                    <li key={h.characterId}>
                      <button
                        type="button"
                        disabled={removingId !== null}
                        onClick={() => onRemoveUnverified({ kind: "holder", holderCharacterId: h.characterId }, h.name)}
                        className="text-red-500/70 hover:text-red-400 disabled:opacity-50"
                      >
                        {removingId === `holder:${h.characterId}` ? "Removing…" : `Remove all ${h.unverified} of ${h.name}'s sheet entries…`}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
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

        {canManage && (
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-neutral-400">
            <input type="checkbox" checked={unverifiedOnly} onChange={(e) => setUnverifiedOnly(e.target.checked)} />
            Unverified only
          </label>
        )}

        <span className="pb-1.5 text-sm text-neutral-500">
          {sortedGroups.length} row{sortedGroups.length === 1 ? "" : "s"} ({filteredRows.length} of {holdings.length} holding
          {holdings.length === 1 ? "" : "s"})
        </span>

        {canManage && BANK_MANUAL_ADD_ENABLED && (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => setAddOpen((v) => !v)}>
            {addOpen ? "Cancel" : "+ Add item"}
          </Button>
        )}
      </div>

      {canManage && BANK_MANUAL_ADD_ENABLED && addOpen && (
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
          <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-sm">
            <span className="text-neutral-400">Audit note (optional)</span>
            <input
              value={addForm.auditNote}
              onChange={(e) => setAddForm({ ...addForm, auditNote: e.target.value })}
              placeholder="e.g. donated by…"
              title="Context for this add's audit-log entry — e.g. who donated it"
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
              <th className="px-3 py-2 font-medium">Note</th>
              {canManage && (
                <th className="sticky right-0 z-10 bg-neutral-900 px-3 py-2 font-medium shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.6)]">Actions</th>
              )}
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
                      <ItemLink name={g.itemName} itemId={g.itemId} />
                      {g.itemId !== null && <span className="ml-1.5 text-xs text-neutral-600">#{g.itemId}</span>}
                      <span className="ml-1.5 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">×{g.rows.length}</span>
                      {g.noDrop && (
                        <span className="ml-1.5 rounded-full bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
                          No drop
                        </span>
                      )}
                      {canManage && g.notFoundCount > 0 && (
                        <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${UNVERIFIED_BADGE.not_found.className}`}>
                          {UNVERIFIED_BADGE.not_found.label} ({g.notFoundCount})
                        </span>
                      )}
                      {canManage && g.notFoundCount === 0 && g.unverifiedCount > 0 && (
                        <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${UNVERIFIED_BADGE.sheet.className}`}>
                          Unverified ({g.unverifiedCount})
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
                    <td className="px-3 py-2 text-neutral-500">—</td>
                    {canManage && (
                      <td className="sticky right-0 z-10 bg-neutral-950 px-3 py-2 text-neutral-600 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.6)]">
                        expand to edit
                      </td>
                    )}
                  </tr>
                  {isOpen &&
                    g.rows.map((row) => {
                      const isEditing = editingId === row.id;
                      return (
                        <tr key={row.id} className="bg-neutral-900/30 text-neutral-300">
                          <td className="px-2 py-2" />
                          {renderRowCells(row, isEditing, true)}
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
