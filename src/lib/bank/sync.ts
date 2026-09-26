import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { bankEqAccountCharacters, bankEqAccounts, bankHoldings, bankImports, bankSlotDesignations, characters, users } from "@/db";

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
};

export async function loadBankConfig(db: Db): Promise<BankSyncConfig> {
  const [designationRows, accountRows, memberRows, importRows, syncedRows] = await Promise.all([
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

  return { personalDesignations, sharedDesignations, accounts, accountByCharacterId, lastImports, syncedContents };
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

// Runs the sync for real: for each holder, delete its existing imported
// (non-currency) holdings, write a bank_imports row, insert the new set
// (carrying forward status/note from a row at the same (container, slot) so
// an officer's note on an imported row survives a re-sync), and refresh
// every designation this holder reported an occupant for — so the "what
// should be here" baseline the officer app's move-detection reads back via
// loadBankConfig always reflects the most recent real sync.
//
// Not fully atomic across the bank_imports insert and everything else: the
// import bookkeeping row is written first, on its own, then the
// delete+insert+designation-refresh runs as one db.batch(). Same pragmatic
// tradeoff the rest of this codebase makes for bookkeeping writes that
// aren't the ledger itself (see standings.ts's markStandingsDirty comment)
// — a failure between the two leaves an orphaned bank_imports row, never a
// half-written holdings set.
export async function applySync(db: Db, userId: string, holders: SyncHolderInput[], config: BankSyncConfig): Promise<ApplySyncResult> {
  const diffs: HolderDiff[] = [];

  for (const holder of holders) {
    const existing = await db
      .select({
        container: bankHoldings.container,
        slotIndex: bankHoldings.slotIndex,
        itemName: bankHoldings.itemName,
        itemId: bankHoldings.itemId,
        quantity: bankHoldings.quantity,
        status: bankHoldings.status,
        note: bankHoldings.note,
      })
      .from(bankHoldings)
      .where(
        and(
          eq(bankHoldings.holderCharacterId, holder.characterId),
          eq(bankHoldings.source, "import"),
          ne(bankHoldings.category, "currency"),
        ),
      );

    diffs.push(diffHolder(holder.characterId, existing, holder.rows));

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

    const accountId = config.accountByCharacterId.get(holder.characterId)?.id;

    const statements: BatchItem<"sqlite">[] = [
      db
        .delete(bankHoldings)
        .where(and(eq(bankHoldings.holderCharacterId, holder.characterId), eq(bankHoldings.source, "import"), ne(bankHoldings.category, "currency"))),
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

    if (statements.length === 1) {
      await db.batch([statements[0]] as [BatchItem<"sqlite">]);
    } else {
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    }
  }

  return { diffs };
}

export async function previewSync(db: Db, holders: SyncHolderInput[]): Promise<ApplySyncResult> {
  const diffs: HolderDiff[] = [];
  for (const holder of holders) {
    const existing = await db
      .select({
        container: bankHoldings.container,
        slotIndex: bankHoldings.slotIndex,
        itemName: bankHoldings.itemName,
        itemId: bankHoldings.itemId,
        quantity: bankHoldings.quantity,
        status: bankHoldings.status,
        note: bankHoldings.note,
      })
      .from(bankHoldings)
      .where(
        and(
          eq(bankHoldings.holderCharacterId, holder.characterId),
          eq(bankHoldings.source, "import"),
          ne(bankHoldings.category, "currency"),
        ),
      );
    diffs.push(diffHolder(holder.characterId, existing, holder.rows));
  }
  return { diffs };
}

// ---------------------------------------------------------------------
// Retiring the old Google-Sheet-imported bank rows (2026-09-25).
//
// Sheet rows are bank_holdings.source='import' with import_id IS NULL
// (scripts/import-bank-tabs.ts, distinct from a real sync's
// source='import' WITH an import_id). A holder's first real sync already
// replaces its own sheet rows (applySync deletes ALL source='import' rows
// for that holder regardless of import_id) — this is for the remainder:
// a holder that will never be synced (no mule assigned, character
// retired, etc.), or an officer who wants to clear the sheet leftovers
// ahead of time rather than waiting for a sync.
// ---------------------------------------------------------------------

export async function retireSheetRows(db: Db, holderCharacterId: number | "all"): Promise<{ removed: number }> {
  const whereClause =
    holderCharacterId === "all"
      ? and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId))
      : and(eq(bankHoldings.source, "import"), isNull(bankHoldings.importId), eq(bankHoldings.holderCharacterId, holderCharacterId));

  const removed = await db.delete(bankHoldings).where(whereClause).returning({ id: bankHoldings.id });
  return { removed: removed.length };
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
