import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bankHoldings, characters } from "@/db";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";

type Db = ReturnType<typeof drizzle>;

export type BankHoldingRow = {
  id: number;
  holderCharacterId: number;
  holderName: string;
  holderCharType: "main" | "alt" | "mule";
  category: "item" | "spell" | "currency";
  container: string;
  slotIndex: number;
  itemName: string;
  itemId: number | null;
  quantity: number;
  classRestriction: string | null;
  status: "guild_bank" | "reserved";
  note: string | null;
  source: "manual" | "import";
};

// PLAN.md §11 task 8.5 — every holding, joined with its holder character so
// the browse table can show/filter by name and char type without a second
// round trip. No status filter here (both guild_bank and reserved come
// back) — the browse table defaults to hiding "reserved" client-side, same
// pattern as RosterTable's default-active status filter, so an officer
// fixing a misclassification can still switch to see everything.
export async function listBankHoldings(db: Db): Promise<BankHoldingRow[]> {
  return db
    .select({
      id: bankHoldings.id,
      holderCharacterId: bankHoldings.holderCharacterId,
      holderName: characters.name,
      holderCharType: characters.charType,
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
    })
    .from(bankHoldings)
    .innerJoin(characters, eq(bankHoldings.holderCharacterId, characters.id))
    .orderBy(characters.name, bankHoldings.container, bankHoldings.slotIndex);
}

export type CreateManualHoldingInput = {
  holderName: string;
  category: "item" | "spell" | "currency";
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

export async function createManualHolding(db: Db, input: CreateManualHoldingInput): Promise<HoldingMutationResult> {
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
): Promise<HoldingMutationResult> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return { error: "Quantity must be a positive number." };

  const result = await db
    .update(bankHoldings)
    .set({ status: input.status, quantity: input.quantity, note: input.note?.trim() || null, updatedAt: new Date() })
    .where(eq(bankHoldings.id, id))
    .returning({ id: bankHoldings.id });

  if (result.length === 0) return { error: "Not found." };
  return { id: result[0].id };
}

// Only a manual row can be deleted here. An imported row's lifecycle is
// delete-and-replace via re-import (§3) — deleting it through this path
// would just get silently recreated (or not, if the mule's export
// genuinely dropped the item) on the next import, so it's not a real
// delete and shouldn't be offered as one.
export async function deleteManualHolding(db: Db, id: number): Promise<HoldingMutationResult> {
  const [existing] = await db.select({ source: bankHoldings.source }).from(bankHoldings).where(eq(bankHoldings.id, id));
  if (!existing) return { error: "Not found." };
  if (existing.source !== "manual") {
    return { error: "Only manually-added rows can be deleted here — an imported row is corrected by re-importing that character's export." };
  }
  await db.delete(bankHoldings).where(eq(bankHoldings.id, id));
  return {};
}
