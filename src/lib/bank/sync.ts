import { and, eq, inArray, ne } from "drizzle-orm";
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
// scope entirely (per the guild's own call), and equipped gear/Cursor/Held
// are never something an officer could plausibly mean as "guild property."
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
// Config: every designation + account group + each holder's last import,
// the shape the parser app needs to build its own sync payload and the
// shape /bank uses to show "last synced" info.
// ---------------------------------------------------------------------

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

export type BankSyncConfig = {
  // Personal designations, keyed by characterId.
  personalDesignations: Map<number, string[]>;
  // SharedBank designations, keyed by eqAccountId.
  sharedDesignations: Map<number, string[]>;
  accounts: BankEqAccountConfig[];
  // Which account (if any) a given character belongs to.
  accountByCharacterId: Map<number, BankEqAccountConfig>;
  lastImports: Map<number, BankImportInfo>;
};

export async function loadBankConfig(db: Db): Promise<BankSyncConfig> {
  const [designationRows, accountRows, memberRows, importRows] = await Promise.all([
    db
      .select({
        characterId: bankSlotDesignations.characterId,
        eqAccountId: bankSlotDesignations.eqAccountId,
        container: bankSlotDesignations.container,
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
  ]);

  const personalDesignations = new Map<number, string[]>();
  const sharedDesignations = new Map<number, string[]>();
  for (const row of designationRows) {
    if (row.characterId !== null) {
      const list = personalDesignations.get(row.characterId) ?? [];
      list.push(row.container);
      personalDesignations.set(row.characterId, list);
    } else if (row.eqAccountId !== null) {
      const list = sharedDesignations.get(row.eqAccountId) ?? [];
      list.push(row.container);
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

  return { personalDesignations, sharedDesignations, accounts, accountByCharacterId, lastImports };
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

export type SyncHolderInput = {
  characterId: number;
  sourceFile: string | null;
  reportsSharedBank: boolean;
  rows: SyncRowInput[];
};

export type SyncValidationError = { characterId: number; error: string };

// Rejects any row whose container isn't actually designated for that
// holder — the officer app already filters to designated containers
// before building a payload, but the server never trusts that: a stale
// client, a hand-crafted request, or a designation an officer just
// cleared out from under an in-flight sync must not slip a personal item
// into the guild bank.
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

    const personalAllowed = new Set(config.personalDesignations.get(holder.characterId) ?? []);
    const sharedAllowed = account ? new Set(config.sharedDesignations.get(account.id) ?? []) : new Set<string>();

    for (const row of holder.rows) {
      if (isValidSharedContainer(row.container)) {
        if (!holder.reportsSharedBank || !sharedAllowed.has(row.container)) {
          errors.push({ characterId: holder.characterId, error: `${row.container} is not a designated shared-bank container for this account.` });
        }
        continue;
      }
      if (!isValidPersonalContainer(row.container)) {
        errors.push({ characterId: holder.characterId, error: `${row.container} is not a syncable container.` });
        continue;
      }
      if (!personalAllowed.has(row.container)) {
        errors.push({ characterId: holder.characterId, error: `${row.container} is not designated as guild bank for this character.` });
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

// Runs the sync for real: for each holder, delete its existing imported
// (non-currency) holdings, write a bank_imports row, and insert the new
// set — carrying forward status/note from a row at the same (container,
// slot) so an officer's note on an imported row survives a re-sync.
//
// Not fully atomic across the bank_imports insert and the holdings
// delete-and-replace: the import bookkeeping row is written first, on its
// own, then the delete+insert runs as one db.batch(). Same pragmatic
// tradeoff the rest of this codebase makes for bookkeeping writes that
// aren't the ledger itself (see standings.ts's markStandingsDirty comment)
// — a failure between the two leaves an orphaned bank_imports row, never a
// half-written holdings set.
export async function applySync(db: Db, userId: string, holders: SyncHolderInput[]): Promise<ApplySyncResult> {
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
// Designations / account group mutations.
// ---------------------------------------------------------------------

export type DesignationOwner = { characterId: number } | { eqAccountId: number };

export async function setDesignations(db: Db, userId: string, owner: DesignationOwner, containers: string[]): Promise<{ error?: string }> {
  const isShared = "eqAccountId" in owner;
  const validator = isShared ? isValidSharedContainer : isValidPersonalContainer;
  const bad = containers.find((c) => !validator(c));
  if (bad) return { error: `"${bad}" is not a valid ${isShared ? "shared-bank" : "personal"} container.` };

  const whereClause = isShared ? eq(bankSlotDesignations.eqAccountId, owner.eqAccountId) : eq(bankSlotDesignations.characterId, owner.characterId);

  await db.delete(bankSlotDesignations).where(whereClause);
  // D1 caps a statement at 100 bound parameters — each row binds 4
  // (characterId, eqAccountId, container, updatedBy), so a single insert
  // tops out well under 30 containers. A real character can have up to 30
  // Bank slots alone (Darkclaw-Inventory.txt has all 30 real) — "mark all
  // Bank slots guild" alone already blows past the 100-param cap with an
  // unchunked insert. Chunk like applySync's bank_holdings insert does.
  const DESIGNATION_CHUNK_SIZE = 20;
  for (let i = 0; i < containers.length; i += DESIGNATION_CHUNK_SIZE) {
    const chunk = containers.slice(i, i + DESIGNATION_CHUNK_SIZE);
    await db.insert(bankSlotDesignations).values(
      chunk.map((container) => ({
        characterId: isShared ? null : owner.characterId,
        eqAccountId: isShared ? owner.eqAccountId : null,
        container,
        updatedBy: userId,
      })),
    );
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
