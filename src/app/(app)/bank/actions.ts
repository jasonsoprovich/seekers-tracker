"use server";

import { createManualHolding, deleteManualHolding, updateHolding, type HoldingMutationResult } from "@/lib/bank/holdings";
import { removeUnverifiedHoldings, type RemoveUnverifiedTarget } from "@/lib/bank/sync";
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

// 2026-09-27 (was retireSheetRowsAction / "Retire"): an officer removes an
// unverified sheet/manual bank row — one item, or every remaining
// unverified row for one holder at once — for an item genuinely gone
// (given away, consumed, never really there) rather than just unsynced
// yet. A holder's first real sync already reconciles most of these
// automatically (src/lib/bank/sync.ts's applySync/reconcileUnverified);
// this is for what a sync can't resolve on its own. Requires a note —
// removeUnverifiedHoldings refuses an empty one — and writes a real
// bank_audit_log row, so this shows up on the Audit tab like any other
// bank change instead of only the admin System Log. Deliberately no
// "remove ALL remaining unverified rows across every holder" option
// anymore — too easy to wipe the whole sheet by accident.
export async function removeUnverifiedHoldingAction(target: RemoveUnverifiedTarget, note: string): Promise<{ error?: string; removed?: number }> {
  const auth = await requireManager();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await removeUnverifiedHoldings(db, target, note, auth.userId);
  if (!result.error && result.removed > 0) {
    await recordSystemEvent(db, await webActor(db, auth.userId), {
      action: "bank.unverified.remove",
      targetType: "bank_holdings",
      summary:
        target.kind === "row"
          ? `Removed unverified bank item #${target.id} (${note})`
          : `Removed all remaining unverified bank rows for character #${target.holderCharacterId} (${result.removed} row(s), ${note})`,
    });
  }
  return result;
}
