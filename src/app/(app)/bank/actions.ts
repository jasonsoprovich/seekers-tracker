"use server";

import { canManageEpgp, getUserRole } from "@/lib/authz";
import { createManualHolding, deleteManualHolding, updateHolding, type HoldingMutationResult } from "@/lib/bank/holdings";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

// Same officer/leader/admin gate as EPGP ledger entries and bids
// (canManageEpgp) — bank content is guild-officer-managed the same way.
async function requireManager(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };
  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) return { error: "Only officers can manage guild bank holdings." };
  return { userId: session.user.id };
}

function parseOptionalInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export type AddHoldingInput = {
  holderName: string;
  category: "item" | "spell" | "currency";
  itemName: string;
  itemId: string;
  quantity: string;
  classRestriction: string;
  status: "guild_bank" | "reserved";
  note: string;
};

// PLAN.md §11 task 8.6 — manual add/edit for items no export captures.
export async function addManualHoldingAction(input: AddHoldingInput): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  return createManualHolding(db, {
    holderName: input.holderName,
    category: input.category,
    itemName: input.itemName,
    itemId: parseOptionalInt(input.itemId),
    quantity: Number(input.quantity),
    classRestriction: input.classRestriction || undefined,
    status: input.status,
    note: input.note || undefined,
  });
}

export type EditHoldingInput = { status: "guild_bank" | "reserved"; quantity: string; note: string };

export async function updateHoldingAction(id: number, input: EditHoldingInput): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  return updateHolding(db, id, { status: input.status, quantity: Number(input.quantity), note: input.note || undefined });
}

export async function deleteHoldingAction(id: number): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  return deleteManualHolding(db, id);
}
