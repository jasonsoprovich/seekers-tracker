"use server";

import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";
import { getDb } from "@/lib/db";
import {
  commitDepartureWipe,
  commitRateDecay,
  previewDepartureWipe,
  previewRateDecay,
  reverseDecayEvent,
  type DecayPreviewRow,
  type DeparturePreviewRow,
} from "@/lib/epgp/decay";
import { getSession } from "@/lib/session";

// Flat optional-field shape (not a discriminated union) so callers can just
// check `.error`, matching every other server action's result type in this
// app (LedgerActionResult, UpdateSettingResult, …).
export type PreviewDecayResult = { rows?: DecayPreviewRow[]; totalEpDecay?: number; totalGpDecay?: number; error?: string };
export type CommitDecayResult = { decayEventId?: number; epRows?: number; gpRows?: number; error?: string };
export type ReverseDecayResult = { error?: string };
export type PreviewDepartureResult = { rows?: DeparturePreviewRow[]; totalEp?: number; unmatchedNames?: string[]; error?: string };
export type CommitDepartureResult = { decayEventId?: number; epRows?: number; unmatchedNames?: string[]; error?: string };

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

function parseInactiveSince(raw: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function splitNames(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((n) => n.trim())
    .filter(Boolean);
}

// Resolves leader-typed names to character ids, same "report what didn't
// match instead of dropping it silently" pattern the officer app's
// attendance route uses (src/app/api/officer/attendance/route.ts).
async function resolveCharacterNames(
  db: Awaited<ReturnType<typeof getDb>>,
  raw: string,
): Promise<{ characterIds: number[]; unmatchedNames: string[] }> {
  const names = [...new Set(splitNames(raw))];
  const characterIds: number[] = [];
  const unmatchedNames: string[] = [];
  for (const name of names) {
    const id = await findCharacterIdByName(db, name);
    if (id === null) unmatchedNames.push(name);
    else characterIds.push(id);
  }
  return { characterIds, unmatchedNames };
}

async function requireLeader(): Promise<{ userId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not signed in." };
  const role = await getUserRole(session.user.id);
  if (!canManageEpgpConfig(role)) return { error: "Only leaders can run EPGP decay." };
  return { userId: session.user.id };
}

// PLAN.md §11 Phase 2 task 2.7, shared by Phase 5 task 5.4 — server actions
// backing the leader UI's rate input -> preview table -> confirm -> result
// flow. Calls src/lib/epgp/decay.ts directly (same functions the
// API-key-authed /api/officer/decay/* routes wrap) rather than hitting
// those routes over HTTP, mirroring how epgp/ledger/actions.ts and
// manual-entry/route.ts both call insertLedgerEntry directly instead of one
// calling the other. previewDecayAction doesn't take a `kind` — the
// preview math (rate x balance before effectiveDate) is identical for
// expansion and global_cycle decay, so ExpansionDecayForm and
// GlobalCycleDecayForm both call this same action; only commit needs to
// say which kind of event it's writing.
export async function previewDecayAction(rateInput: string, effectiveDateInput: string): Promise<PreviewDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const rate = parseRate(rateInput);
  if (rate === null) return { error: "Rate must be a number greater than 0 and at most 1 (e.g. 0.85 for 85%)." };
  const effectiveDate = parseEffectiveDate(effectiveDateInput);
  if (!effectiveDate) return { error: "Pick a valid effective date." };

  const db = await getDb();
  const rows = await previewRateDecay(db, rate, effectiveDate);
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
  return commitRateDecay(db, { kind: "expansion", rate, effectiveDate, label: label.trim() || undefined, appliedBy: auth.userId });
}

// PLAN.md §11 Phase 5 task 5.3/5.4 — same shape as commitDecayAction, but
// writes a global_cycle decay_events row (§1c: 10% against the total,
// compounding, leader-triggered by button rather than cron because cycles
// shift a day or two). GlobalCycleDecayForm reuses previewDecayAction above
// for its preview step.
export async function commitGlobalCycleDecayAction(rateInput: string, effectiveDateInput: string, label: string): Promise<CommitDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const rate = parseRate(rateInput);
  if (rate === null) return { error: "Rate must be a number greater than 0 and at most 1 (e.g. 0.10 for 10%)." };
  const effectiveDate = parseEffectiveDate(effectiveDateInput);
  if (!effectiveDate) return { error: "Pick a valid effective date." };

  const db = await getDb();
  return commitRateDecay(db, { kind: "global_cycle", rate, effectiveDate, label: label.trim() || undefined, appliedBy: auth.userId });
}

export async function reverseDecayAction(decayEventId: number): Promise<ReverseDecayResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const db = await getDb();
  const result = await reverseDecayEvent(db, decayEventId, auth.userId);
  if ("error" in result) return { error: result.error };
  return {};
}

// PLAN.md §11 Phase 2 tasks 2.9-2.12 (§1f) — the leader-requested,
// non-destructive EP wipe. namesInput and inactiveSinceInput are
// alternative selection modes (names win if both are given, matching
// previewDepartureWipe/commitDepartureWipe); unmatched names come back so
// the leader can fix a typo rather than have it silently drop.
export async function previewDepartureAction(namesInput: string, inactiveSinceInput: string): Promise<PreviewDepartureResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const db = await getDb();
  const names = splitNames(namesInput);
  let characterIds: number[] | undefined;
  let unmatchedNames: string[] | undefined;
  if (names.length > 0) {
    const resolved = await resolveCharacterNames(db, namesInput);
    characterIds = resolved.characterIds;
    unmatchedNames = resolved.unmatchedNames;
  }
  const inactiveSince = parseInactiveSince(inactiveSinceInput);
  if (!characterIds?.length && !inactiveSince) {
    return { error: "Enter at least one character name, or an inactive-since date.", unmatchedNames };
  }

  const rows = await previewDepartureWipe(db, { characterIds, inactiveSince });
  const totalEp = rows.reduce((sum, r) => sum + r.epBalance, 0);
  return { rows, totalEp, unmatchedNames };
}

export async function commitDepartureAction(namesInput: string, inactiveSinceInput: string, label: string): Promise<CommitDepartureResult> {
  const auth = await requireLeader();
  if ("error" in auth) return auth;

  const db = await getDb();
  const names = splitNames(namesInput);
  let characterIds: number[] | undefined;
  let unmatchedNames: string[] | undefined;
  if (names.length > 0) {
    const resolved = await resolveCharacterNames(db, namesInput);
    characterIds = resolved.characterIds;
    unmatchedNames = resolved.unmatchedNames;
  }
  const inactiveSince = parseInactiveSince(inactiveSinceInput);
  if (!characterIds?.length && !inactiveSince) {
    return { error: "Enter at least one character name, or an inactive-since date.", unmatchedNames };
  }

  const result = await commitDepartureWipe(db, { characterIds, inactiveSince, label: label.trim() || undefined, appliedBy: auth.userId });
  if ("error" in result) return { error: result.error, unmatchedNames };
  return { ...result, unmatchedNames };
}
