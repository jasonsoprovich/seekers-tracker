import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { bankEqAccountCharacters, bankEqAccounts, bankHoldings, bankImports, bankSlotDesignations, characters, users } from "@/db";
import { bankAuditStatements, type BankAuditInsert } from "@/lib/bank/audit";

type Db = ReturnType<typeof drizzle>;

// ---------------------------------------------------------------------
// Container naming/validation (PLAN.md §9 addendum).
//
// Designations and synced holdings both key off the SAME container string
// bank_holdings.container already uses for a bag/bank slot: "General1",
// "Bank12", "SharedBank7". Currency ("*-Coin") and non-bag equipment/
// cursor locations are never valid containers here — currency is out of
// scope entirely (per the guild's own call, reinforced 2026-09-25: nobody,
// officers included, needs it visible, and bank_holdings.category
// 'currency' rows were purged in migration 0050), and equipped gear/
// Cursor/Held are never something an officer could plausibly mean as
// "guild property."
// ---------------------------------------------------------------------

const PERSONAL_CONTAINER_RE = /^(General[1-9][0-9]?|Bank([1-9]|[12][0-9]|30))$/;
// bankexport already drops SharedBank11-30 as dead slots server never
// populates (see internal/bankexport/location.go) — the website enforces
// the same ceiling independently rather than trusting the client.
const SHARED_CONTAINER_RE = /^SharedBank([1-9]|10)$/;

export function isValidPersonalContainer(container: string): boolean {
  return PERSONAL_CONTAINER_RE.test(container);
}

export function isValidSharedContainer(container: string): boolean {
  return SHARED_CONTAINER_RE.test(container);
}

// ---------------------------------------------------------------------
// Config: every designation + account group + each holder's last import +
// each holder's last-synced contents — the shape the parser app needs to
// build its own sync payload (and detect a bag that's moved since the last
// sync/designation, internal/bankexport/moves.go) and the shape /bank uses
// to show "last synced" info.
// ---------------------------------------------------------------------

// A single flagged position. slotIndex 0 means the whole top-level
// container (the bag object and everything in it, or a loose item sitting
// directly in the slot); 1..N flags only that one item inside the bag.
// expectedItemId/expectedItemName is the occupant last seen at this exact
// position (the bag itself, for slotIndex 0) — the baseline the officer
// app's move-detection compares a fresh scan against. Both null until the
// first scan/sync sets them (a brand-new designation with nothing known
// yet).
export type DesignationSlot = {
  container: string;
  slotIndex: number;
  expectedItemId: number | null;
  expectedItemName: string | null;
};

export type BankEqAccountConfig = {
  id: number;
  label: string;
  sharedBankHolderCharacterId: number;
  characterIds: number[];
};

export type BankImportInfo = {
  characterId: number;
  sourceFile: string | null;
  rowCount: number;
  reportsSharedBank: boolean;
  uploadedByName: string | null;
  createdAt: Date;
};

// What actually landed at a (container, slotIndex) on the holder's most
// recent real sync — distinct from DesignationSlot.expected*, which is
// scoped to a flagged position and updated on every scan (see applySync's
// occupants handling below); this is scoped to whatever the holder's last
// *sync* actually wrote, flagged or not, for the officer app's broader
// "does this look different since last time" comparison.
export type SyncedOccupant = { container: string; slotIndex: number; itemId: number | null; itemName: string };

// One unverified (sheet or manual) item still sitting on a holder, for the
// officer app's Guild Bank tab to suggest a bag to flag before that
// holder's next sync — 2026-09-27 unverified-item tracking. `notFound` is
// true once a real sync of this holder has already failed to match it
// (needs review), false while it's simply pending its holder's first sync.
export type UnverifiedContentEntry = {
  itemName: string;
  itemId: number | null;
  quantity: number;
  legacyLocation: string | null;
  kind: "sheet" | "manual";
  notFound: boolean;
};

export type BankSyncConfig = {
  // Personal designations, keyed by characterId.
  personalDesignations: Map<number, DesignationSlot[]>;
  // SharedBank designations, keyed by eqAccountId.
  sharedDesignations: Map<number, DesignationSlot[]>;
  accounts: BankEqAccountConfig[];
  // Which account (if any) a given character belongs to.
  accountByCharacterId: Map<number, BankEqAccountConfig>;
  lastImports: Map<number, BankImportInfo>;
  // Last-synced contents per holder characterId — the baseline for "has
  // this changed since the last real sync" independent of designation.
  syncedContents: Map<number, SyncedOccupant[]>;
  // Unverified sheet/manual items still on each holder, keyed by
  // characterId — what SuggestFlags (parser side) compares a fresh scan
  // against to suggest "Bank8 holds items the sheet listed as guild bank."
  unverifiedContents: Map<number, UnverifiedContentEntry[]>;
};

export async function loadBankConfig(db: Db): Promise<BankSyncConfig> {
  const [designationRows, accountRows, memberRows, importRows, syncedRows, unverifiedRows] = await Promise.all([
    db
      .select({
        characterId: bankSlotDesignations.characterId,
        eqAccountId: bankSlotDesignations.eqAccountId,
        container: bankSlotDesignations.container,
        slotIndex: bankSlotDesignations.slotIndex,
        expectedItemId: bankSlotDesignations.expectedItemId,
        expectedItemName: bankSlotDesignations.expectedItemName,
      })
      .from(bankSlotDesignations),
    db
      .select({
        id: bankEqAccounts.id,
        label: bankEqAccounts.label,
        sharedBankHolderCharacterId: bankEqAccounts.sharedBankHolderCharacterId,
      })
      .from(bankEqAccounts),
    db
      .select({ characterId: bankEqAccountCharacters.characterId, eqAccountId: bankEqAccountCharacters.eqAccountId })
      .from(bankEqAccountCharacters),
    db
      .select({
        characterId: bankImports.characterId,
        sourceFile: bankImports.sourceFile,
        rowCount: bankImports.rowCount,
        reportsSharedBank: bankImports.reportsSharedBank,
        createdAt: bankImports.createdAt,
        uploadedByName: users.username,
      })
      .from(bankImports)
      .leftJoin(users, eq(bankImports.uploadedBy, users.id))
      .orderBy(bankImports.createdAt),
    db
      .select({
        holderCharacterId: bankHoldings.holderCharacterId,
        container: bankHoldings.container,
        slotIndex: bankHoldings.slotIndex,
        itemId: bankHoldings.itemId,
        itemName: bankHoldings.itemName,
      })
      .from(bankHoldings)
      .where(and(eq(bankHoldings.source, "import"), isNotNull(bankHoldings.importId))),
    db
      .select({
        holderCharacterId: bankHoldings.holderCharacterId,
        itemName: bankHoldings.itemName,
        itemId: bankHoldings.itemId,
        quantity: bankHoldings.quantity,
        legacyLocation: bankHoldings.legacyLocation,
        source: bankHoldings.source,
        notFoundSince: bankHoldings.notFoundSince,
      })
      .from(bankHoldings)
      .where(
        and(
          ne(bankHoldings.category, "currency"),
          or(eq(bankHoldings.source, "manual"), and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId))),
        ),
      ),
  ]);

  const personalDesignations = new Map<number, DesignationSlot[]>();
  const sharedDesignations = new Map<number, DesignationSlot[]>();
  for (const row of designationRows) {
    const slot: DesignationSlot = {
      container: row.container,
      slotIndex: row.slotIndex,
      expectedItemId: row.expectedItemId,
      expectedItemName: row.expectedItemName,
    };
    if (row.characterId !== null) {
      const list = personalDesignations.get(row.characterId) ?? [];
      list.push(slot);
      personalDesignations.set(row.characterId, list);
    } else if (row.eqAccountId !== null) {
      const list = sharedDesignations.get(row.eqAccountId) ?? [];
      list.push(slot);
      sharedDesignations.set(row.eqAccountId, list);
    }
  }

  const membersByAccount = new Map<number, number[]>();
  for (const row of memberRows) {
    const list = membersByAccount.get(row.eqAccountId) ?? [];
    list.push(row.characterId);
    membersByAccount.set(row.eqAccountId, list);
  }

  const accounts: BankEqAccountConfig[] = accountRows.map((row) => ({
    id: row.id,
    label: row.label,
    sharedBankHolderCharacterId: row.sharedBankHolderCharacterId,
    characterIds: membersByAccount.get(row.id) ?? [],
  }));

  const accountByCharacterId = new Map<number, BankEqAccountConfig>();
  for (const account of accounts) {
    for (const characterId of account.characterIds) accountByCharacterId.set(characterId, account);
  }

  // Last import per holder — importRows is ordered oldest-first, so the
  // last write into the Map for a given character is the newest.
  const lastImports = new Map<number, BankImportInfo>();
  for (const row of importRows) {
    lastImports.set(row.characterId, {
      characterId: row.characterId,
      sourceFile: row.sourceFile,
      rowCount: row.rowCount,
      reportsSharedBank: row.reportsSharedBank,
      uploadedByName: row.uploadedByName,
      createdAt: row.createdAt,
    });
  }

  const syncedContents = new Map<number, SyncedOccupant[]>();
  for (const row of syncedRows) {
    const list = syncedContents.get(row.holderCharacterId) ?? [];
    list.push({ container: row.container, slotIndex: row.slotIndex, itemId: row.itemId, itemName: row.itemName });
    syncedContents.set(row.holderCharacterId, list);
  }

  const unverifiedContents = new Map<number, UnverifiedContentEntry[]>();
  for (const row of unverifiedRows) {
    const list = unverifiedContents.get(row.holderCharacterId) ?? [];
    list.push({
      itemName: row.itemName,
      itemId: row.itemId,
      quantity: row.quantity,
      legacyLocation: row.legacyLocation,
      kind: row.source === "manual" ? "manual" : "sheet",
      notFound: row.notFoundSince !== null,
    });
    unverifiedContents.set(row.holderCharacterId, list);
  }

  return { personalDesignations, sharedDesignations, accounts, accountByCharacterId, lastImports, syncedContents, unverifiedContents };
}

// ---------------------------------------------------------------------
// Sync payload validation + diff + apply.
// ---------------------------------------------------------------------

export type SyncRowInput = {
  container: string;
  slotIndex: number;
  category: "item" | "spell";
  itemName: string;
  itemId: number | null;
  quantity: number;
};

// What's actually sitting at one of this holder's designated positions
// right now, sent alongside the sync rows so the server can refresh each
// designation's expected_item_id/expected_item_name baseline — the officer
// app's own moves.go already resolved any mismatch against the PRIOR
// baseline before letting the sync proceed (an unresolved warning blocks
// that character's sync entirely), so by the time a payload reaches here
// the occupant list is simply "what to remember for next time."
export type OccupantInput = { container: string; slotIndex: number; itemId: number | null; itemName: string };

export type SyncHolderInput = {
  characterId: number;
  sourceFile: string | null;
  reportsSharedBank: boolean;
  rows: SyncRowInput[];
  occupants: OccupantInput[];
};

export type SyncValidationError = { characterId: number; error: string };

function designationMatches(slots: DesignationSlot[], container: string, slotIndex: number): boolean {
  return slots.some((s) => s.container === container && (s.slotIndex === 0 || s.slotIndex === slotIndex));
}

// Rejects any row whose container/slot isn't actually designated for that
// holder — the officer app already filters to designated positions before
// building a payload, but the server never trusts that: a stale client, a
// hand-crafted request, or a designation an officer just cleared out from
// under an in-flight sync must not slip a personal item into the guild
// bank. A slotIndex-0 designation ("the whole bag") covers every row in
// that container; a designation at slotIndex N covers only a row at that
// exact slot.
export function validateSyncPayload(holders: SyncHolderInput[], config: BankSyncConfig): SyncValidationError[] {
  const errors: SyncValidationError[] = [];

  for (const holder of holders) {
    const account = config.accountByCharacterId.get(holder.characterId);
    if (holder.reportsSharedBank && (!account || account.sharedBankHolderCharacterId !== holder.characterId)) {
      errors.push({
        characterId: holder.characterId,
        error: "This character is not the designated SharedBank holder for its EQ account group.",
      });
      continue;
    }

    const personalAllowed = config.personalDesignations.get(holder.characterId) ?? [];
    const sharedAllowed = account ? (config.sharedDesignations.get(account.id) ?? []) : [];

    for (const row of holder.rows) {
      if (isValidSharedContainer(row.container)) {
        if (!holder.reportsSharedBank || !designationMatches(sharedAllowed, row.container, row.slotIndex)) {
          errors.push({ characterId: holder.characterId, error: `${row.container} slot ${row.slotIndex} is not a designated shared-bank position for this account.` });
        }
        continue;
      }
      if (!isValidPersonalContainer(row.container)) {
        errors.push({ characterId: holder.characterId, error: `${row.container} is not a syncable container.` });
        continue;
      }
      if (!designationMatches(personalAllowed, row.container, row.slotIndex)) {
        errors.push({ characterId: holder.characterId, error: `${row.container} slot ${row.slotIndex} is not designated as guild bank for this character.` });
      }
    }
  }

  return errors;
}

type ExistingHoldingRow = {
  container: string;
  slotIndex: number;
  category: "item" | "spell" | "currency";
  itemName: string;
  itemId: number | null;
  quantity: number;
  status: "guild_bank" | "reserved";
  note: string | null;
};

export type HolderDiffRow = { container: string; slotIndex: number; itemName: string; quantity: number };
export type HolderDiff = {
  characterId: number;
  added: HolderDiffRow[];
  removed: HolderDiffRow[];
  changed: { before: HolderDiffRow; after: HolderDiffRow }[];
  unchanged: number;
  // Unverified (sheet/manual) rows this sync matched against an incoming
  // synced row, and ones it couldn't find anywhere — 2026-09-27 unverified-
  // item tracking (see reconcileUnverified below). Optional so an older
  // parser build decoding this JSON without knowing these fields still
  // works; both are always present from this version of the server.
  verified?: HolderDiffRow[];
  notFound?: HolderDiffRow[];
};

function slotKey(container: string, slotIndex: number): string {
  return `${container}::${slotIndex}`;
}

function diffHolder(characterId: number, existing: ExistingHoldingRow[], incoming: SyncRowInput[]): HolderDiff {
  const existingByKey = new Map(existing.map((r) => [slotKey(r.container, r.slotIndex), r]));
  const incomingByKey = new Map(incoming.map((r) => [slotKey(r.container, r.slotIndex), r]));

  const added: HolderDiffRow[] = [];
  const changed: { before: HolderDiffRow; after: HolderDiffRow }[] = [];
  let unchanged = 0;

  for (const [key, row] of incomingByKey) {
    const prior = existingByKey.get(key);
    if (!prior) {
      added.push({ container: row.container, slotIndex: row.slotIndex, itemName: row.itemName, quantity: row.quantity });
      continue;
    }
    if (prior.itemName !== row.itemName || prior.itemId !== row.itemId || prior.quantity !== row.quantity) {
      changed.push({
        before: { container: prior.container, slotIndex: prior.slotIndex, itemName: prior.itemName, quantity: prior.quantity },
        after: { container: row.container, slotIndex: row.slotIndex, itemName: row.itemName, quantity: row.quantity },
      });
    } else {
      unchanged += 1;
    }
  }

  const removed: HolderDiffRow[] = [];
  for (const [key, row] of existingByKey) {
    if (!incomingByKey.has(key)) removed.push({ container: row.container, slotIndex: row.slotIndex, itemName: row.itemName, quantity: row.quantity });
  }

  return { characterId, added, removed, changed, unchanged };
}

// The item-level audit trail for one holder's sync — same key-matching
// logic as diffHolder above but with the full snapshot bank_audit_log
// needs (category/itemId/status/note), not the trimmed shape the officer
// app's preview UI reads. Kept separate rather than widening diffHolder's
// own return type: that type is also the JSON contract
// /api/officer/bank/sync returns to the parser app, and this doesn't need
// to touch it. carriesOver mirrors applySync's own insert logic exactly
// (below) so a "changed" row's audited `after` matches what actually got
// written, not a guess.
//
// suppressCreateKeys (2026-09-27): (container, slotIndex) keys of an
// incoming row that reconcileUnverified already matched against an
// unverified sheet/manual row — that match already writes its own
// action:'verify' audit row (see applySync below) covering the full
// before/after context, so the ordinary 'create' row for the same slot is
// skipped rather than logging what would read as an unrelated duplicate
// ("removed" + "added" for what was really one "confirmed" event, exactly
// the noise 2026-09-27 officer feedback flagged).
function buildSyncAuditRows(
  characterId: number,
  existing: ExistingHoldingRow[],
  incoming: SyncRowInput[],
  changedBy: string,
  suppressCreateKeys?: Set<string>,
): BankAuditInsert[] {
  const existingByKey = new Map(existing.map((r) => [slotKey(r.container, r.slotIndex), r]));
  const incomingByKey = new Map(incoming.map((r) => [slotKey(r.container, r.slotIndex), r]));
  const rows: BankAuditInsert[] = [];

  for (const [key, row] of incomingByKey) {
    const prior = existingByKey.get(key);
    if (!prior) {
      if (suppressCreateKeys?.has(key)) continue;
      rows.push({
        holderCharacterId: characterId,
        itemName: row.itemName,
        action: "create",
        source: "sync",
        changedBy,
        before: null,
        after: { container: row.container, slotIndex: row.slotIndex, category: row.category, itemName: row.itemName, itemId: row.itemId, quantity: row.quantity, status: "guild_bank", note: null },
      });
      continue;
    }
    if (prior.itemName !== row.itemName || prior.itemId !== row.itemId || prior.quantity !== row.quantity) {
      const carriesOver = prior.itemId === row.itemId && prior.itemName === row.itemName;
      rows.push({
        holderCharacterId: characterId,
        itemName: row.itemName,
        action: "update",
        source: "sync",
        changedBy,
        before: { container: prior.container, slotIndex: prior.slotIndex, category: prior.category, itemName: prior.itemName, itemId: prior.itemId, quantity: prior.quantity, status: prior.status, note: prior.note },
        after: {
          container: row.container,
          slotIndex: row.slotIndex,
          category: row.category,
          itemName: row.itemName,
          itemId: row.itemId,
          quantity: row.quantity,
          status: carriesOver ? prior.status : "guild_bank",
          note: carriesOver ? prior.note : null,
        },
      });
    }
  }

  for (const [key, prior] of existingByKey) {
    if (incomingByKey.has(key)) continue;
    rows.push({
      holderCharacterId: characterId,
      itemName: prior.itemName,
      action: "delete",
      source: "sync",
      changedBy,
      before: { container: prior.container, slotIndex: prior.slotIndex, category: prior.category, itemName: prior.itemName, itemId: prior.itemId, quantity: prior.quantity, status: prior.status, note: prior.note },
      after: null,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------
// Unverified (sheet/manual) row reconciliation — 2026-09-27.
//
// Guild bank sync launched on top of live sheet-migrated data (§9's
// original design assumed a clean slate). Wiping every sheet row the
// moment a mule's FIRST sync lands would hurt transparency (members would
// see items vanish with no visible reason) and risks genuinely losing
// track of items an officer just hasn't flagged the right bag for yet.
// Jason's own framing: "all old items from the guild bank are unverified
// or unsynced, until that character's inventory is synced from the officer
// app, then those items are picked up." This is that pickup logic.
//
// A row is UNVERIFIED when it isn't backed by a real sync: either a sheet
// row (source='import', import_id IS NULL — migration 0053 moved these to
// container='Sheet') or a manual row (source='manual', container='Manual').
// applySync's own existing-holdings query (below) only ever compares
// against VERIFIED rows (import_id IS NOT NULL) for its create/update/
// delete diff — unverified rows are handled entirely here instead, and are
// never deleted outright by a sync; they're either matched (deleted, with
// a 'verify' audit row) or left in place and flagged notFoundSince for an
// officer to review.
export type UnverifiedHoldingRow = {
  id: number;
  category: "item" | "spell" | "currency";
  itemName: string;
  itemId: number | null;
  quantity: number;
  status: "guild_bank" | "reserved";
  note: string | null;
  container: string;
  slotIndex: number;
  legacyLocation: string | null;
  notFoundSince: Date | null;
};

function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatIncomingLocation(row: SyncRowInput): string {
  return row.slotIndex === 0 ? row.container : `${row.container}-Slot${row.slotIndex}`;
}

export type ReconcileMatch = { unverifiedId: number; matchedRow: SyncRowInput; consumedQuantity: number; remainingQuantity: number };
export type ReconcileOutcome = { kind: "matched"; match: ReconcileMatch } | { kind: "not_found"; unverifiedId: number };

// Matches this holder's unverified rows against its incoming synced rows by
// item name, preferring an exact legacy-location match first. Deliberately
// a name/location heuristic, not a guaranteed-optimal assignment — false
// negatives just land the row in the officer-facing "needs review" list
// (never silently dropped), which is the intended safety net per Jason's
// own call: "we need to be careful of how this is handled... but we need
// to be able to distinguish items that are not from an app bank sync."
//
// Two passes per unverified row, first match wins, quantity consumed from
// a shared per-incoming-row remaining pool so one small incoming stack
// can't be double-counted as confirming several different oversized sheet
// entries of the same name:
//   1. Same normalized item name AND the incoming row's own container/slot
//      formats to exactly this row's legacyLocation — the strongest
//      signal ("this is probably the literal same physical item").
//   2. Same normalized item name anywhere else in this holder's incoming
//      rows, for whatever quantity pass 1 didn't already claim.
// A full match (nothing left unconsumed) deletes the unverified row. A
// partial match (some quantity confirmed, some not) reduces its quantity
// instead of deleting it — "Quantities are consumed as rows match... a
// partial match lowers the unverified row's quantity" per the confirmed
// design. No match at all reports not_found so applySync can set
// notFoundSince.
//
// Known limitation, accepted rather than engineered around: matching
// re-runs fresh against whatever the CURRENT sync's rows are every time,
// with no memory of what a PRIOR sync already confirmed. A partially-
// matched sheet row re-syncs against the same unchanged real items on a
// later sync and keeps shrinking (e.g. qty 10 → 6 → 2 → 0 over three
// no-op re-syncs of the same 4 real items) even though nothing new was
// actually found. Harmless — it only ever converges toward fully verified,
// never toward false removal — and every step is its own audited 'verify'
// row, so the trail stays honest even if the pacing looks odd.
export function reconcileUnverified(unverified: UnverifiedHoldingRow[], incoming: SyncRowInput[]): ReconcileOutcome[] {
  const incomingRemaining = incoming.map((r) => r.quantity);
  const outcomes: ReconcileOutcome[] = [];

  // Stable order (by id) so results are deterministic and testable.
  const sorted = [...unverified].sort((a, b) => a.id - b.id);

  for (const u of sorted) {
    let remaining = u.quantity;
    let matchedRow: SyncRowInput | null = null;
    let consumed = 0;

    if (u.legacyLocation) {
      for (let i = 0; i < incoming.length && remaining > 0; i++) {
        if (incomingRemaining[i] <= 0) continue;
        const row = incoming[i];
        if (normalizeItemName(row.itemName) !== normalizeItemName(u.itemName)) continue;
        if (formatIncomingLocation(row) !== u.legacyLocation) continue;
        const take = Math.min(remaining, incomingRemaining[i]);
        incomingRemaining[i] -= take;
        remaining -= take;
        consumed += take;
        matchedRow = matchedRow ?? row;
      }
    }

    if (remaining > 0) {
      for (let i = 0; i < incoming.length && remaining > 0; i++) {
        if (incomingRemaining[i] <= 0) continue;
        const row = incoming[i];
        if (normalizeItemName(row.itemName) !== normalizeItemName(u.itemName)) continue;
        const take = Math.min(remaining, incomingRemaining[i]);
        incomingRemaining[i] -= take;
        remaining -= take;
        consumed += take;
        matchedRow = matchedRow ?? row;
      }
    }

    if (matchedRow && consumed > 0) {
      outcomes.push({ kind: "matched", match: { unverifiedId: u.id, matchedRow, consumedQuantity: consumed, remainingQuantity: remaining } });
    } else {
      outcomes.push({ kind: "not_found", unverifiedId: u.id });
    }
  }

  return outcomes;
}

// Every unverified (sheet/manual) row for a holder — the pool
// reconcileUnverified matches an incoming sync against. Excludes currency
// (purged everywhere, migration 0050) same as every other bank query.
async function fetchUnverifiedHoldings(db: Db, holderCharacterId: number): Promise<UnverifiedHoldingRow[]> {
  const rows = await db
    .select({
      id: bankHoldings.id,
      category: bankHoldings.category,
      itemName: bankHoldings.itemName,
      itemId: bankHoldings.itemId,
      quantity: bankHoldings.quantity,
      status: bankHoldings.status,
      note: bankHoldings.note,
      container: bankHoldings.container,
      slotIndex: bankHoldings.slotIndex,
      legacyLocation: bankHoldings.legacyLocation,
      notFoundSince: bankHoldings.notFoundSince,
    })
    .from(bankHoldings)
    .where(
      and(
        eq(bankHoldings.holderCharacterId, holderCharacterId),
        ne(bankHoldings.category, "currency"),
        or(eq(bankHoldings.source, "manual"), and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId))),
      ),
    );
  return rows.map((r) => ({ ...r, category: r.category as "item" | "spell" | "currency" }));
}

function unverifiedSnapshot(row: UnverifiedHoldingRow, quantity: number) {
  return { container: row.container, slotIndex: row.slotIndex, category: row.category, itemName: row.itemName, itemId: row.itemId, quantity, status: row.status, note: row.note };
}

// Backs /bank's "under construction" banner (bank/page.tsx) — true while
// ANY holder anywhere still has an unverified sheet/manual row, false the
// moment the last one is either synced away or removed. Cheap existence
// check, not a count.
export async function hasUnverifiedBankRows(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: bankHoldings.id })
    .from(bankHoldings)
    .where(
      and(
        ne(bankHoldings.category, "currency"),
        or(eq(bankHoldings.source, "manual"), and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId))),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// D1 caps a statement at 100 bound parameters. Each inserted row binds 8
// values (holderCharacterId, category, container, slotIndex, itemName,
// itemId, quantity, status, note, source, importId — status/note/source
// carried below bring it to 11); chunk conservatively.
const INSERT_CHUNK_SIZE = 8;

export type ApplySyncResult = { diffs: HolderDiff[] };

// Resolves which designation owner (a character, or its EQ account) a
// given container belongs to, so an occupant update lands on the right
// bank_slot_designations row.
function occupantOwnerClause(container: string, holder: SyncHolderInput, accountId: number | undefined) {
  if (isValidSharedContainer(container)) {
    if (accountId === undefined) return undefined;
    return eq(bankSlotDesignations.eqAccountId, accountId);
  }
  return eq(bankSlotDesignations.characterId, holder.characterId);
}

// Verified-only existing-holdings fetch — the diff/audit base a sync
// compares against. import_id IS NOT NULL is what makes this "verified":
// a sheet row (import_id NULL) or a manual row is never in scope here, see
// the reconciliation section above.
async function fetchVerifiedHoldings(db: Db, holderCharacterId: number): Promise<ExistingHoldingRow[]> {
  return db
    .select({
      container: bankHoldings.container,
      slotIndex: bankHoldings.slotIndex,
      category: bankHoldings.category,
      itemName: bankHoldings.itemName,
      itemId: bankHoldings.itemId,
      quantity: bankHoldings.quantity,
      status: bankHoldings.status,
      note: bankHoldings.note,
    })
    .from(bankHoldings)
    .where(
      and(
        eq(bankHoldings.holderCharacterId, holderCharacterId),
        eq(bankHoldings.source, "import"),
        isNotNull(bankHoldings.importId),
        ne(bankHoldings.category, "currency"),
      ),
    );
}

// Runs the sync for real: for each holder, delete its existing VERIFIED
// (non-currency) holdings, write a bank_imports row, insert the new set
// (carrying forward status/note from a row at the same (container, slot) so
// an officer's note on an imported row survives a re-sync), reconcile any
// unverified sheet/manual rows against the incoming set (2026-09-27 — see
// the section above), and refresh every designation this holder reported an
// occupant for — so the "what should be here" baseline the officer app's
// move-detection reads back via loadBankConfig always reflects the most
// recent real sync.
//
// Not fully atomic across the bank_imports insert and everything else: the
// import bookkeeping row is written first, on its own, then the
// delete+insert+designation-refresh+reconciliation runs as one db.batch().
// Same pragmatic tradeoff the rest of this codebase makes for bookkeeping
// writes that aren't the ledger itself (see standings.ts's
// markStandingsDirty comment) — a failure between the two leaves an
// orphaned bank_imports row, never a half-written holdings set.
export async function applySync(db: Db, userId: string, holders: SyncHolderInput[], config: BankSyncConfig): Promise<ApplySyncResult> {
  const diffs: HolderDiff[] = [];

  for (const holder of holders) {
    const existing = await fetchVerifiedHoldings(db, holder.characterId);
    const unverified = await fetchUnverifiedHoldings(db, holder.characterId);
    const reconciled = reconcileUnverified(unverified, holder.rows);
    const unverifiedById = new Map(unverified.map((u) => [u.id, u]));

    // (container, slotIndex) keys of an incoming row that reconciliation
    // matched — buildSyncAuditRows skips the ordinary 'create' row for
    // these (the 'verify' row below already covers it).
    const matchedIncomingKeys = new Set<string>();
    for (const outcome of reconciled) {
      if (outcome.kind === "matched") matchedIncomingKeys.add(slotKey(outcome.match.matchedRow.container, outcome.match.matchedRow.slotIndex));
    }

    const diff = diffHolder(holder.characterId, existing, holder.rows);
    diff.verified = [];
    diff.notFound = [];
    const auditRows = buildSyncAuditRows(holder.characterId, existing, holder.rows, userId, matchedIncomingKeys);

    const existingByKey = new Map(existing.map((r) => [slotKey(r.container, r.slotIndex), r]));

    const [importRow] = await db
      .insert(bankImports)
      .values({
        characterId: holder.characterId,
        uploadedBy: userId,
        sourceFile: holder.sourceFile,
        rowCount: holder.rows.length,
        reportsSharedBank: holder.reportsSharedBank,
      })
      .returning({ id: bankImports.id });

    const batchId = `sync:${importRow.id}`;
    for (const row of auditRows) row.batchId = batchId;

    const accountId = config.accountByCharacterId.get(holder.characterId)?.id;

    const statements: BatchItem<"sqlite">[] = [
      db
        .delete(bankHoldings)
        .where(
          and(
            eq(bankHoldings.holderCharacterId, holder.characterId),
            eq(bankHoldings.source, "import"),
            isNotNull(bankHoldings.importId),
            ne(bankHoldings.category, "currency"),
          ),
        ),
    ];

    for (let i = 0; i < holder.rows.length; i += INSERT_CHUNK_SIZE) {
      const chunk = holder.rows.slice(i, i + INSERT_CHUNK_SIZE);
      statements.push(
        db.insert(bankHoldings).values(
          chunk.map((row) => {
            const prior = existingByKey.get(slotKey(row.container, row.slotIndex));
            const carriesOver = prior && prior.itemId === row.itemId && prior.itemName === row.itemName;
            return {
              holderCharacterId: holder.characterId,
              category: row.category,
              container: row.container,
              slotIndex: row.slotIndex,
              itemName: row.itemName,
              itemId: row.itemId,
              quantity: row.quantity,
              status: carriesOver ? prior.status : "guild_bank",
              note: carriesOver ? prior.note : null,
              source: "import" as const,
              importId: importRow.id,
            };
          }),
        ),
      );
    }

    for (const occupant of holder.occupants) {
      const ownerClause = occupantOwnerClause(occupant.container, holder, accountId);
      if (!ownerClause) continue;
      statements.push(
        db
          .update(bankSlotDesignations)
          .set({ expectedItemId: occupant.itemId, expectedItemName: occupant.itemName, updatedBy: userId, updatedAt: new Date() })
          .where(and(ownerClause, eq(bankSlotDesignations.container, occupant.container), eq(bankSlotDesignations.slotIndex, occupant.slotIndex))),
      );
    }

    // Unverified reconciliation — a matched row is deleted (full match) or
    // has its quantity reduced (partial match) with its own 'verify' audit
    // row either way; a not-found row just gets its notFoundSince column
    // stamped — no audit row for that, deliberately: it isn't a change to
    // the holding's own data (no before/after worth logging), it's purely
    // the review flag the Browse UI reads (BankHoldingRow.unverifiedState).
    // Stamped only the FIRST time (row.notFoundSince still null) so a
    // holder synced repeatedly without the item ever turning up doesn't
    // re-write the same timestamp on every pass.
    const fullyMatchedIds: number[] = [];
    for (const outcome of reconciled) {
      if (outcome.kind === "not_found") {
        const row = unverifiedById.get(outcome.unverifiedId)!;
        // Reported in the diff every time (so "Not found: M" always
        // reflects the full current state), regardless of whether this is
        // the first sync to notice or the tenth.
        diff.notFound!.push({ container: row.container, slotIndex: row.slotIndex, itemName: row.itemName, quantity: row.quantity });
        if (row.notFoundSince === null) {
          statements.push(
            db.update(bankHoldings).set({ notFoundSince: new Date(), updatedAt: new Date() }).where(eq(bankHoldings.id, row.id)),
          );
        }
        continue;
      }

      const row = unverifiedById.get(outcome.match.unverifiedId)!;
      const { matchedRow, consumedQuantity, remainingQuantity } = outcome.match;
      diff.verified!.push({ container: matchedRow.container, slotIndex: matchedRow.slotIndex, itemName: matchedRow.itemName, quantity: consumedQuantity });

      if (remainingQuantity === 0) {
        fullyMatchedIds.push(row.id);
        auditRows.push({
          holderCharacterId: holder.characterId,
          itemName: row.itemName,
          action: "verify",
          source: "sync",
          changedBy: userId,
          before: unverifiedSnapshot(row, row.quantity),
          after: { container: matchedRow.container, slotIndex: matchedRow.slotIndex, category: matchedRow.category, itemName: matchedRow.itemName, itemId: matchedRow.itemId, quantity: consumedQuantity, status: "guild_bank", note: null },
          batchId,
        });
      } else {
        statements.push(
          db
            .update(bankHoldings)
            .set({ quantity: remainingQuantity, notFoundSince: null, updatedAt: new Date() })
            .where(eq(bankHoldings.id, row.id)),
        );
        auditRows.push({
          holderCharacterId: holder.characterId,
          itemName: row.itemName,
          action: "verify",
          source: "sync",
          changedBy: userId,
          before: unverifiedSnapshot(row, row.quantity),
          after: unverifiedSnapshot(row, remainingQuantity),
          batchId,
        });
      }
    }
    if (fullyMatchedIds.length > 0) {
      statements.push(db.delete(bankHoldings).where(inArray(bankHoldings.id, fullyMatchedIds)));
    }

    diffs.push(diff);

    // Item-level audit trail (bank_audit_log) — chunked into the SAME
    // batch as this holder's holdings delete+insert, so it commits
    // atomically with the sync it describes.
    statements.push(...bankAuditStatements(db, auditRows));

    if (statements.length === 1) {
      await db.batch([statements[0]] as [BatchItem<"sqlite">]);
    } else {
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    }
  }

  return { diffs };
}

// Read-only counterpart to applySync's diff — same verified-only existing
// query and the same reconciliation pass (so the officer app's Preview
// dialog can show "Verified from sheet: N / Not found: M" before the
// officer commits to anything), but writes nothing.
export async function previewSync(db: Db, holders: SyncHolderInput[]): Promise<ApplySyncResult> {
  const diffs: HolderDiff[] = [];
  for (const holder of holders) {
    const existing = await fetchVerifiedHoldings(db, holder.characterId);
    const unverified = await fetchUnverifiedHoldings(db, holder.characterId);
    const reconciled = reconcileUnverified(unverified, holder.rows);
    const unverifiedById = new Map(unverified.map((u) => [u.id, u]));

    const diff = diffHolder(holder.characterId, existing, holder.rows);
    diff.verified = [];
    diff.notFound = [];
    for (const outcome of reconciled) {
      if (outcome.kind === "not_found") {
        const row = unverifiedById.get(outcome.unverifiedId)!;
        diff.notFound!.push({ container: row.container, slotIndex: row.slotIndex, itemName: row.itemName, quantity: row.quantity });
      } else {
        const { matchedRow, consumedQuantity } = outcome.match;
        diff.verified!.push({ container: matchedRow.container, slotIndex: matchedRow.slotIndex, itemName: matchedRow.itemName, quantity: consumedQuantity });
      }
    }
    diffs.push(diff);
  }
  return { diffs };
}

// ---------------------------------------------------------------------
// Removing unverified (sheet/manual) bank rows (2026-09-25, reworked
// 2026-09-27 as "remove unverified item" — was retireSheetRows).
//
// An unverified row is bank_holdings.source='manual', or source='import'
// with import_id IS NULL (a sheet row — scripts/import-bank-tabs.ts;
// distinct from a real sync's source='import' WITH an import_id). A
// holder's first real sync reconciles its unverified rows automatically
// (applySync/reconcileUnverified above) — this is for what a sync can't
// resolve on its own: an item genuinely gone (given away, consumed, never
// existed) that an officer wants to clear by hand, one row or a whole
// holder's remaining unverified rows at once.
//
// 2026-09-27: this is now an audited deletion, not a silent one — Jason's
// own concern was ensuring the guild bank stays "accurate" and
// "transparent" through the sheet-to-sync transition, so removing an
// unverified item now requires a note (who received it / why it's gone)
// and writes a real bank_audit_log row, same as every other bank mutation.
// The old bulk "retire ALL remaining sheet rows across every holder"
// button is deliberately gone — too easy to wipe the whole sheet by
// accident; per-holder (or per-item) removal, each with its own note, is
// the only path now.
export type RemoveUnverifiedTarget = { kind: "row"; id: number } | { kind: "holder"; holderCharacterId: number };

export async function removeUnverifiedHoldings(
  db: Db,
  target: RemoveUnverifiedTarget,
  note: string,
  changedBy: string,
): Promise<{ removed: number; error?: string }> {
  const trimmedNote = note.trim();
  if (!trimmedNote) return { removed: 0, error: "A note is required — say who received the item, or why it's being removed." };

  const unverifiedClause = or(eq(bankHoldings.source, "manual"), and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId)));
  const whereClause =
    target.kind === "row"
      ? and(eq(bankHoldings.id, target.id), ne(bankHoldings.category, "currency"), unverifiedClause)
      : and(eq(bankHoldings.holderCharacterId, target.holderCharacterId), ne(bankHoldings.category, "currency"), unverifiedClause);

  const rows = await db.select().from(bankHoldings).where(whereClause);
  if (rows.length === 0) return { removed: 0 };

  const batchId = rows.length > 1 ? `retire:${crypto.randomUUID()}` : null;
  const auditRows: BankAuditInsert[] = rows.map((r) => ({
    holdingId: r.id,
    holderCharacterId: r.holderCharacterId,
    itemName: r.itemName,
    action: "delete",
    source: "manual",
    changedBy,
    before: { container: r.container, slotIndex: r.slotIndex, category: r.category, itemName: r.itemName, itemId: r.itemId, quantity: r.quantity, status: r.status, note: r.note },
    after: null,
    note: trimmedNote,
    batchId,
  }));

  await db.batch([db.delete(bankHoldings).where(whereClause), ...bankAuditStatements(db, auditRows)] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return { removed: rows.length };
}

// ---------------------------------------------------------------------
// Designations / account group mutations.
// ---------------------------------------------------------------------

export type DesignationOwner = { characterId: number } | { eqAccountId: number };

export type DesignationInput = { container: string; slotIndex: number; expectedItemId?: number | null; expectedItemName?: string | null };

// D1 caps a statement at 100 bound parameters — each row binds 7
// (characterId, eqAccountId, container, slotIndex, expectedItemId,
// expectedItemName, updatedBy), so 15/chunk (105 params) actually blows
// the cap — confirmed live by this file's own verify script tripping
// "too many SQL variables" the first time this was tried. 10/chunk (70
// params) leaves real headroom. A real character can have up to 30 Bank
// slots alone (Darkclaw-Inventory.txt has all 30 real) plus, since
// per-item designation shipped, potentially many more sub-slot rows —
// "mark all Bank slots guild" alone already blew past the cap with an
// unchunked insert (found 2026-09-24).
const DESIGNATION_CHUNK_SIZE = 10;

function validateContainers(isShared: boolean, slots: { container: string }[]): string | undefined {
  const validator = isShared ? isValidSharedContainer : isValidPersonalContainer;
  const bad = slots.find((s) => !validator(s.container));
  if (bad) return `"${bad.container}" is not a valid ${isShared ? "shared-bank" : "personal"} container.`;
  return undefined;
}

// Replaces, adds to, or removes from one owner's designated positions.
// Exactly one of set/add/remove is expected per call (the officer app's
// per-checkbox toggles use add/remove now, so flipping one container never
// touches — and never silently drops — any other container's flag; "Mark
// all X guild"/"Clear all personal" still use `set` for a wholesale
// replace). remove takes bare {container, slotIndex} pairs; add/set take
// full DesignationInput so a fresh flag can seed its expected occupant
// immediately from the current scan instead of waiting for the next sync.
export async function updateDesignations(
  db: Db,
  userId: string,
  owner: DesignationOwner,
  ops: { set?: DesignationInput[]; add?: DesignationInput[]; remove?: { container: string; slotIndex: number }[] },
): Promise<{ error?: string }> {
  const isShared = "eqAccountId" in owner;
  const ownerClause = isShared ? eq(bankSlotDesignations.eqAccountId, owner.eqAccountId) : eq(bankSlotDesignations.characterId, owner.characterId);

  if (ops.set) {
    const badMsg = validateContainers(isShared, ops.set);
    if (badMsg) return { error: badMsg };

    await db.delete(bankSlotDesignations).where(ownerClause);
    for (let i = 0; i < ops.set.length; i += DESIGNATION_CHUNK_SIZE) {
      const chunk = ops.set.slice(i, i + DESIGNATION_CHUNK_SIZE);
      await db.insert(bankSlotDesignations).values(
        chunk.map((slot) => ({
          characterId: isShared ? null : owner.characterId,
          eqAccountId: isShared ? owner.eqAccountId : null,
          container: slot.container,
          slotIndex: slot.slotIndex,
          expectedItemId: slot.expectedItemId ?? null,
          expectedItemName: slot.expectedItemName ?? null,
          updatedBy: userId,
        })),
      );
    }
  }

  if (ops.remove && ops.remove.length > 0) {
    const badMsg = validateContainers(isShared, ops.remove);
    if (badMsg) return { error: badMsg };
    for (const slot of ops.remove) {
      await db
        .delete(bankSlotDesignations)
        .where(and(ownerClause, eq(bankSlotDesignations.container, slot.container), eq(bankSlotDesignations.slotIndex, slot.slotIndex)));
    }
  }

  if (ops.add && ops.add.length > 0) {
    const badMsg = validateContainers(isShared, ops.add);
    if (badMsg) return { error: badMsg };
    for (let i = 0; i < ops.add.length; i += DESIGNATION_CHUNK_SIZE) {
      const chunk = ops.add.slice(i, i + DESIGNATION_CHUNK_SIZE);
      await db
        .insert(bankSlotDesignations)
        .values(
          chunk.map((slot) => ({
            characterId: isShared ? null : owner.characterId,
            eqAccountId: isShared ? owner.eqAccountId : null,
            container: slot.container,
            slotIndex: slot.slotIndex,
            expectedItemId: slot.expectedItemId ?? null,
            expectedItemName: slot.expectedItemName ?? null,
            updatedBy: userId,
          })),
        )
        .onConflictDoUpdate({
          target: isShared
            ? [bankSlotDesignations.eqAccountId, bankSlotDesignations.container, bankSlotDesignations.slotIndex]
            : [bankSlotDesignations.characterId, bankSlotDesignations.container, bankSlotDesignations.slotIndex],
          set: { updatedBy: userId, updatedAt: new Date() },
        });
      // Note: an add() re-flagging an already-designated position does NOT
      // overwrite its expected_* baseline — only a real sync's occupants
      // do that (applySync above). An idempotent re-add shouldn't reset
      // move-detection state.
    }
  }

  return {};
}

export type SaveAccountInput = { id?: number; label: string; characterIds: number[]; sharedBankHolderCharacterId: number };

export async function saveEqAccount(db: Db, userId: string, input: SaveAccountInput): Promise<{ error?: string; id?: number }> {
  const label = input.label.trim();
  if (!label) return { error: "Label is required." };
  if (input.characterIds.length === 0) return { error: "An account group needs at least one character." };
  if (!input.characterIds.includes(input.sharedBankHolderCharacterId)) {
    return { error: "The SharedBank holder must be one of the group's own characters." };
  }
  const dupes = new Set(input.characterIds);
  if (dupes.size !== input.characterIds.length) return { error: "Duplicate character in group." };

  const existingRows = await db
    .select({ id: characters.id })
    .from(characters)
    .where(inArray(characters.id, input.characterIds));
  if (existingRows.length !== input.characterIds.length) return { error: "One or more characters do not exist." };

  let accountId = input.id;
  if (accountId !== undefined) {
    await db
      .update(bankEqAccounts)
      .set({ label, sharedBankHolderCharacterId: input.sharedBankHolderCharacterId, updatedBy: userId, updatedAt: new Date() })
      .where(eq(bankEqAccounts.id, accountId));
  } else {
    const [row] = await db
      .insert(bankEqAccounts)
      .values({ label, sharedBankHolderCharacterId: input.sharedBankHolderCharacterId, updatedBy: userId })
      .returning({ id: bankEqAccounts.id });
    accountId = row.id;
  }

  // A character can belong to at most one account — pull it out of any
  // other group before assigning it here (explicit, not relied on via FK
  // cascade — this codebase's established pattern for multi-step deletes).
  await db.delete(bankEqAccountCharacters).where(inArray(bankEqAccountCharacters.characterId, input.characterIds));
  await db.insert(bankEqAccountCharacters).values(input.characterIds.map((characterId) => ({ characterId, eqAccountId: accountId! })));

  return { id: accountId };
}

export async function deleteEqAccount(db: Db, id: number): Promise<{ error?: string }> {
  // Explicit child cleanup ahead of the parent delete — mirrors this
  // codebase's established multi-step delete pattern (e.g. reverseRaid
  // nulling loot_events.winning_bid_id before deleting bids) rather than
  // depending solely on the schema's onDelete: cascade.
  await db.delete(bankSlotDesignations).where(eq(bankSlotDesignations.eqAccountId, id));
  await db.delete(bankEqAccountCharacters).where(eq(bankEqAccountCharacters.eqAccountId, id));
  const result = await db.delete(bankEqAccounts).where(eq(bankEqAccounts.id, id)).returning({ id: bankEqAccounts.id });
  if (result.length === 0) return { error: "Not found." };
  return {};
}
