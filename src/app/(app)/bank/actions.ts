"use server";

import { createManualHolding, deleteManualHolding, updateHolding, type HoldingMutationResult } from "@/lib/bank/holdings";
import { getDb } from "@/lib/db";
import { getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { recordSystemEvent, webActor } from "@/lib/system-log";

// Same officer/leader/admin default as EPGP ledger entries and bids
// ("epgp.bank.manage") — bank content is guild-officer-managed the same way.
async function requireManager(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };
  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.bank.manage")) return { error: "Only officers can manage guild bank holdings." };
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
  category: "item" | "spell";
  itemName: string;
  itemId: string;
  quantity: string;
  classRestriction: string;
  status: "guild_bank" | "reserved";
  note: string;
  // Audit-log context, e.g. "donated by Thoric" — distinct from `note`
  // above, which is the holding's own persistent note.
  auditNote: string;
};

// PLAN.md §11 task 8.6 — manual add/edit for items no export captures.
// Currency is never an option here (2026-09-25: nobody, officers
// included, needs it visible) — `category` is item/spell only at the
// type level, and createManualHolding's own signature matches, so a
// currency row can't be created through this path even by a stale client.
export async function addManualHoldingAction(input: AddHoldingInput): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await createManualHolding(
    db,
    {
      holderName: input.holderName,
      category: input.category,
      itemName: input.itemName,
      itemId: parseOptionalInt(input.itemId),
      quantity: Number(input.quantity),
      classRestriction: input.classRestriction || undefined,
      status: input.status,
      note: input.note || undefined,
      auditNote: input.auditNote || undefined,
    },
    auth.userId,
  );
  if (result.id != null) {
    await recordSystemEvent(db, await webActor(db, auth.userId), {
      action: "bank.holding.create",
      targetType: "bank_holding",
      targetId: result.id,
      targetLabel: input.itemName,
      summary: `Bank holding added: ${input.itemName} x${input.quantity} (${input.holderName})`,
      after: input,
    });
  }
  return result;
}

export type EditHoldingInput = { status: "guild_bank" | "reserved"; quantity: string; note: string; auditNote: string };

export async function updateHoldingAction(id: number, input: EditHoldingInput): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await updateHolding(
    db,
    id,
    { status: input.status, quantity: Number(input.quantity), note: input.note || undefined, auditNote: input.auditNote || undefined },
    auth.userId,
  );
  if (result.id != null) {
    await recordSystemEvent(db, await webActor(db, auth.userId), {
      action: "bank.holding.update",
      targetType: "bank_holding",
      targetId: id,
      summary: `Bank holding #${id} edited`,
      after: input,
    });
  }
  return result;
}

export async function deleteHoldingAction(id: number, auditNote?: string): Promise<HoldingMutationResult> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await deleteManualHolding(db, id, auth.userId, auditNote);
  if (!result.error) {
    await recordSystemEvent(db, await webActor(db, auth.userId), {
      action: "bank.holding.delete",
      targetType: "bank_holding",
      targetId: id,
      summary: `Bank holding #${id} deleted`,
    });
  }
  return result;
}

