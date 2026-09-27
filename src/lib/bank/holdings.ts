import { and, eq, ne, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { bankHoldings, characters, players } from "@/db";
import { recordBankAuditRow, type BankHoldingSnapshot } from "@/lib/bank/audit";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";
import { isNoDropItem } from "@/lib/eqstat/item-nodrop";

type Db = ReturnType<typeof drizzle>;

export type BankHoldingRow = {
  id: number;
  holderCharacterId: number;
  holderName: string;
  holderCharType: "main" | "alt" | "mule";
  // The main character tied to the holder's account, if any — 2026-09-25
  // officer feedback: "Darkseller may be a mule for the main character
  // Darkmule" — members need to know who to actually contact. Resolved
  // characters.player_id -> players.main_character_id -> characters.name,
  // falling back to the holder's own characters.main_character_id ->
  // characters.name when that chain comes up empty (see listBankHoldings'
  // comment on that fallback — a real, not-uncommon split where a
  // character's player_id points at a different players row than the one
  // its owner actually logged in under). Null only when NEITHER resolves —
  // the holder has no player account and no direct main pointer at all.
  ownerMainName: string | null;
  category: "item" | "spell";
  container: string;
  slotIndex: number;
  // The original sheet position ("Bank3-Slot2") for a sheet-migrated row —
  // migration 0053 moved container/slotIndex to a synthetic "Sheet" +
  // running counter, so this is what the Location column actually shows
  // for one of these rows instead of the meaningless synthetic slot. Null
  // for every other row (a real synced position, or a manual/no-location
  // sheet row).
  legacyLocation: string | null;
  itemName: string;
  itemId: number | null;
  quantity: number;
  classRestriction: string | null;
  status: "guild_bank" | "reserved";
  note: string | null;
  source: "manual" | "import";
  // source='import' with a NULL import_id is a row that came from the old
  // Google Sheet migration (scripts/import-bank-tabs.ts), never from a
  // real officer-app sync (which always sets import_id) — surfaced so
  // officers can tell which numbers are still pre-transition.
  fromSheet: boolean;
  // True when itemId resolves to a Quarm NO DROP item — see
  // src/lib/eqstat/item-nodrop.ts. Always false when itemId is null
  // (sheet/manual rows never captured one).
  noDrop: boolean;
  // 2026-09-27 unverified-item tracking (src/lib/bank/sync.ts's
  // reconcileUnverified). null = a real synced row, nothing to show.
  // "sheet"/"manual" = still waiting on this holder's first sync.
  // "not_found" = a real sync of this holder ran and couldn't match it —
  // needs officer review. Officer-only in the UI (BankBrowseTable gates
  // this on canManage) — members see every row exactly the same either
  // way, no badges, nothing missing.
  unverifiedState: "sheet" | "manual" | "not_found" | null;
};

const mainCharacters = alias(characters, "main_characters");
// Fallback path for listBankHoldings' Main column — see its comment.
// Roster's own alt→main grouping already learned this lesson (2026-08-29,
// "Alt→main roster grouping fix" in this repo's CLAUDE.md): a character's
// OWN main_character_id is the more direct, always-current signal for
// "who does this belong to," whereas the player_id -> players.main_
// character_id chain can drift when a character's player_id points at a
// different players row than the one its owner's login actually resolved
// to (a real, not-uncommon split — resolvePlayerForUser/attachCharacterTo
// Player don't guarantee every character on an account shares one players
// row). Both chains are tried; the direct one wins when the indirect one
// comes up empty.
const directMainCharacters = alias(characters, "direct_main_characters");

// PLAN.md §11 task 8.5 — every holding, joined with its holder character
// (and, transitively, the holder's account's main character) so the
// browse table can show/filter by name, char type, and account owner
// without extra round trips. Currency is excluded entirely (2026-09-25:
// nobody needs it visible; migration 0050 already purged existing rows,
// this is belt-and-suspenders against a stray future write). No status
// filter here (both guild_bank and reserved come back) — the browse table
// defaults to hiding "reserved" client-side, same pattern as
// RosterTable's default-active status filter, so an officer fixing a
// misclassification can still switch to see everything.
export async function listBankHoldings(db: Db): Promise<BankHoldingRow[]> {
  const rows = await db
    .select({
      id: bankHoldings.id,
      holderCharacterId: bankHoldings.holderCharacterId,
      holderName: characters.name,
      holderCharType: characters.charType,
      ownerMainName: sql<string | null>`coalesce(${mainCharacters.name}, ${directMainCharacters.name})`,
      category: bankHoldings.category,
      container: bankHoldings.container,
      slotIndex: bankHoldings.slotIndex,
      legacyLocation: bankHoldings.legacyLocation,
      itemName: bankHoldings.itemName,
      itemId: bankHoldings.itemId,
      quantity: bankHoldings.quantity,
      classRestriction: bankHoldings.classRestriction,
      status: bankHoldings.status,
      note: bankHoldings.note,
      source: bankHoldings.source,
      importId: bankHoldings.importId,
      notFoundSince: bankHoldings.notFoundSince,
    })
    .from(bankHoldings)
    .innerJoin(characters, eq(bankHoldings.holderCharacterId, characters.id))
    .leftJoin(players, eq(characters.playerId, players.id))
    .leftJoin(mainCharacters, eq(players.mainCharacterId, mainCharacters.id))
    .leftJoin(directMainCharacters, eq(characters.mainCharacterId, directMainCharacters.id))
    .where(ne(bankHoldings.category, "currency"))
    .orderBy(characters.name, bankHoldings.container, bankHoldings.slotIndex);

  return rows.map((row) => {
    const isSheet = row.source === "import" && row.importId === null;
    const isManual = row.source === "manual";
    const unverifiedState: BankHoldingRow["unverifiedState"] =
      row.notFoundSince !== null ? "not_found" : isSheet ? "sheet" : isManual ? "manual" : null;
    return {
      ...row,
      category: row.category as "item" | "spell",
      fromSheet: isSheet,
      noDrop: isNoDropItem(row.itemId),
      unverifiedState,
    };
  });
}

export type CreateManualHoldingInput = {
  holderName: string;
  category: "item" | "spell";
  itemName: string;
  itemId?: number;
  quantity: number;
  classRestriction?: string;
  status: "guild_bank" | "reserved";
  note?: string;
  // Context for the audit-log row itself (e.g. "donated by Thoric") —
  // distinct from `note` above, which is the holding's own persistent
  // note shown on /bank.
  auditNote?: string;
};

export type HoldingMutationResult = { error?: string; id?: number };

// A manual entry (task 8.6 — items no export captures) has no real bag/
// slot, so it can't reuse a real Location's container/slot_index the way
// an import row does. "Manual" can never collide with a real export's
// container names (always "General"/"Bank"/"SharedBank" + a bag number,
// or a raw EQ location string like "Head"/"Bank-Coin" — never literally
// "Manual"), and slotIndex is a per-holder running counter under it, so
// the (holder_character_id, container, slot_index) unique index still
// holds without the caller having to pick a slot number.
const manualContainer = "Manual";

type HoldingSnapshotSource = {
  container: string;
  slotIndex: number;
  category: "item" | "spell" | "currency";
  itemName: string;
  itemId: number | null;
  quantity: number;
  status: "guild_bank" | "reserved";
  note: string | null;
};

function snapshotOf(row: HoldingSnapshotSource): BankHoldingSnapshot {
  return {
    container: row.container,
    slotIndex: row.slotIndex,
    category: row.category,
    itemName: row.itemName,
    itemId: row.itemId,
    quantity: row.quantity,
    status: row.status,
    note: row.note,
  };
}

export async function createManualHolding(db: Db, input: CreateManualHoldingInput, changedBy: string): Promise<HoldingMutationResult> {
  const itemName = input.itemName.trim();
  if (!itemName) return { error: "Item name is required." };
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return { error: "Quantity must be a positive number." };

  const holderCharacterId = await findCharacterIdByName(db, input.holderName);
  if (holderCharacterId === null) return { error: `No character named "${input.holderName}".` };

  const [{ maxSlot }] = await db
    .select({ maxSlot: sql<number>`coalesce(max(${bankHoldings.slotIndex}), 0)` })
    .from(bankHoldings)
    .where(and(eq(bankHoldings.holderCharacterId, holderCharacterId), eq(bankHoldings.container, manualContainer)));

  const [row] = await db
    .insert(bankHoldings)
    .values({
      holderCharacterId,
      category: input.category,
      container: manualContainer,
      slotIndex: maxSlot + 1,
      itemName,
      itemId: input.itemId ?? null,
      quantity: input.quantity,
      classRestriction: input.classRestriction?.trim() || null,
      status: input.status,
      note: input.note?.trim() || null,
      source: "manual",
    })
    .returning();

  await recordBankAuditRow(db, {
    holdingId: row.id,
    holderCharacterId,
    itemName: row.itemName,
    action: "create",
    source: "manual",
    changedBy,
    before: null,
    after: snapshotOf(row),
    note: input.auditNote?.trim() || null,
  });

  return { id: row.id };
}

// Editable on any row regardless of source — an officer correcting a
// misclassified imported item doesn't need to wait for a re-import, per
// the "row-level override" option in data/imports/bank/README.md. Only
// status/note/quantity change: editing an imported row's item identity
// (name/container/slot) would just be silently overwritten by the next
// re-import anyway (§3's delete-and-replace), so there's no point exposing
// that here.
export async function updateHolding(
  db: Db,
  id: number,
  input: { status: "guild_bank" | "reserved"; quantity: number; note?: string; auditNote?: string },
  changedBy: string,
): Promise<HoldingMutationResult> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return { error: "Quantity must be a positive number." };

  const [before] = await db.select().from(bankHoldings).where(eq(bankHoldings.id, id));
  if (!before) return { error: "Not found." };

  const [after] = await db
    .update(bankHoldings)
    .set({ status: input.status, quantity: input.quantity, note: input.note?.trim() || null, updatedAt: new Date() })
    .where(eq(bankHoldings.id, id))
    .returning();

  await recordBankAuditRow(db, {
    holdingId: id,
    holderCharacterId: after.holderCharacterId,
    itemName: after.itemName,
    action: "update",
    source: "manual",
    changedBy,
    before: snapshotOf(before),
    after: snapshotOf(after),
    note: input.auditNote?.trim() || null,
  });

  return { id: after.id };
}

// Only a manual row can be deleted here. An imported row's lifecycle is
// delete-and-replace via re-import (§3) — deleting it through this path
// would just get silently recreated (or not, if the mule's export
// genuinely dropped the item) on the next import, so it's not a real
// delete and shouldn't be offered as one.
export async function deleteManualHolding(db: Db, id: number, changedBy: string, auditNote?: string): Promise<HoldingMutationResult> {
  const [existing] = await db.select().from(bankHoldings).where(eq(bankHoldings.id, id));
  if (!existing) return { error: "Not found." };
  if (existing.source !== "manual") {
    return { error: "Only manually-added rows can be deleted here — an imported row is corrected by re-importing that character's export." };
  }
  await db.delete(bankHoldings).where(eq(bankHoldings.id, id));

  await recordBankAuditRow(db, {
    holdingId: id,
    holderCharacterId: existing.holderCharacterId,
    itemName: existing.itemName,
    action: "delete",
    source: "manual",
    changedBy,
    before: snapshotOf(existing),
    after: null,
    note: auditNote?.trim() || null,
  });

  return {};
}
