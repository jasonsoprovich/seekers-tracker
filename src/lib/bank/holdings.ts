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
  // characters.player_id -> players.main_character_id -> characters.name;
  // null when the holder has no player account at all (never synced/
  // claimed) or that player has no main set yet.
  ownerMainName: string | null;
  category: "item" | "spell";
  container: string;
  slotIndex: number;
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
};

const mainCharacters = alias(characters, "main_characters");

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
      ownerMainName: mainCharacters.name,
      category: bankHoldings.category,
      container: bankHoldings.container,
      slotIndex: bankHoldings.slotIndex,
      itemName: bankHoldings.itemName,
      itemId: bankHoldings.itemId,
      quantity: bankHoldings.quantity,
      classRestriction: bankHoldings.classRestriction,
      status: bankHoldings.status,
      note: bankHoldings.note,
      source: bankHoldings.source,
      importId: bankHoldings.importId,
    })
    .from(bankHoldings)
    .innerJoin(characters, eq(bankHoldings.holderCharacterId, characters.id))
    .leftJoin(players, eq(characters.playerId, players.id))
    .leftJoin(mainCharacters, eq(players.mainCharacterId, mainCharacters.id))
    .where(ne(bankHoldings.category, "currency"))
    .orderBy(characters.name, bankHoldings.container, bankHoldings.slotIndex);

  return rows.map((row) => ({
    ...row,
    category: row.category as "item" | "spell",
    fromSheet: row.source === "import" && row.importId === null,
    noDrop: isNoDropItem(row.itemId),
  }));
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
  input: { status: "guild_bank" | "reserved"; quantity: number; note?: string },
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
  });

  return { id: after.id };
}

// Only a manual row can be deleted here. An imported row's lifecycle is
// delete-and-replace via re-import (§3) — deleting it through this path
// would just get silently recreated (or not, if the mule's export
// genuinely dropped the item) on the next import, so it's not a real
// delete and shouldn't be offered as one.
export async function deleteManualHolding(db: Db, id: number, changedBy: string): Promise<HoldingMutationResult> {
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
  });

  return {};
}
