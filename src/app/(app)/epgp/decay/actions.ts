"use server";

import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { commitExpansionDecay, previewExpansionDecay, reverseDecayEvent, type DecayPreviewRow } from "@/lib/epgp/decay";
import { getSession } from "@/lib/session";

// Flat optional-field shape (not a discriminated union) so callers can just
// check `.error`, matching every other server action's result type in this
// app (LedgerActionResult, UpdateSettingResult, …).
export type PreviewDecayResult = { rows?: DecayPreviewRow[]; totalEpDecay?: number; totalGpDecay?: number; error?: string };
export type CommitDecayResult = { decayEventId?: number; epRows?: number; gpRows?: number; error?: string };
export type ReverseDecayResult = { error?: string };

function parseRate(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
}

function parseEffectiveDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function requireLeader(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };
  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) return { error: "Only leaders can run EPGP decay." };
  return { userId: session.user.id };
}

// PLAN.md §11 Phase 2 task 2.7 — server actions backing the leader UI's
// rate input -> preview table -> confirm -> result flow. Calls
// src/lib/epgp/decay.ts directly (same functions the API-key-authed
// /api/officer/decay/* routes wrap) rather than hitting those routes over
// HTTP, mirroring how epgp/ledger/actions.ts and manual-entry/route.ts both
// call insertLedgerEntry directly instead of one calling the other.
export async function previewDecayAction(rateInput: string, effectiveDateInput: string): Promise<PreviewDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const rate = parseRate(rateInput);
  if (rate === null) return { error: "Rate must be a number greater than 0 and at most 1 (e.g. 0.85 for 85%)." };
  const effectiveDate = parseEffectiveDate(effectiveDateInput);
  if (!effectiveDate) return { error: "Pick a valid effective date." };

  const db = await getDb();
  const rows = await previewExpansionDecay(db, rate, effectiveDate);
  const totalEpDecay = rows.reduce((sum, r) => sum + r.epDecay, 0);
  const totalGpDecay = rows.reduce((sum, r) => sum + r.gpDecay, 0);
  return { rows, totalEpDecay, totalGpDecay };
}

export async function commitDecayAction(rateInput: string, effectiveDateInput: string, label: string): Promise<CommitDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const rate = parseRate(rateInput);
  if (rate === null) return { error: "Rate must be a number greater than 0 and at most 1 (e.g. 0.85 for 85%)." };
  const effectiveDate = parseEffectiveDate(effectiveDateInput);
  if (!effectiveDate) return { error: "Pick a valid effective date." };

  const db = await getDb();
  return commitExpansionDecay(db, { rate, effectiveDate, label: label.trim() || undefined, appliedBy: auth.userId });
}

export async function reverseDecayAction(decayEventId: number): Promise<ReverseDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await reverseDecayEvent(db, decayEventId, auth.userId);
  if ("error" in result) return { error: result.error };
  return {};
}
