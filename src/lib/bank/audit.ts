import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { bankAuditLog, characters, users } from "@/db";

type Db = ReturnType<typeof drizzle>;

// Item-level history for the guild bank — see the bank_audit_log schema
// comment (src/db/schema.ts) for why this is a dedicated table rather than
// a row shape shared with EP/GP's ledger_audit_log or folded into the
// generic system_event_log. This module is the one place that writes it:
// sync.ts's applySync (source: "sync", one row per item added/removed/
// changed by a real officer-app sync) and holdings.ts's manual add/edit/
// delete (source: "manual").

export type BankHoldingSnapshot = {
  container: string;
  slotIndex: number;
  // Matches bank_holdings.category's own enum (never actually "currency"
  // here in practice — every caller filters those rows out before this
  // point — but the column's type includes it, so the snapshot type does
  // too rather than lying about it).
  category: "item" | "spell" | "currency";
  itemName: string;
  itemId: number | null;
  quantity: number;
  status: "guild_bank" | "reserved";
  note: string | null;
};

// "verify" (2026-09-27): a sync matched this item against an existing
// unverified sheet/manual row instead of that row being a plain delete and
// the synced item a plain create — see sync.ts's reconcileUnverified.
export type BankAuditAction = "create" | "update" | "delete" | "verify";
export type BankAuditSource = "manual" | "sync";

export type BankAuditInsert = {
  holdingId?: number | null;
  holderCharacterId: number;
  itemName: string;
  action: BankAuditAction;
  source: BankAuditSource;
  changedBy: string;
  before: BankHoldingSnapshot | null;
  after: BankHoldingSnapshot | null;
  // Officer-entered context for this specific event — e.g. "donated by
  // Thoric" on a create, "given to Kessra" on a delete. Manual rows only;
  // a sync-sourced row never carries one (see schema.ts's column comment).
  note?: string | null;
  // Groups every row from one sync or one bulk action for the Audit tab's
  // collapsed-batch view (see schema.ts's column comment). A caller writing
  // a single one-off row (a manual add/edit/delete) leaves this undefined.
  batchId?: string | null;
};

// For a single mutation outside an existing db.batch() (the manual add/
// edit/delete paths in holdings.ts) — sequential, non-atomic with the
// mutation it describes, same pragmatic tradeoff this codebase already
// makes for bookkeeping writes (see standings.ts's markStandingsDirty
// comment). A lost audit row is strictly better than a rolled-back
// mutation.
export async function recordBankAuditRow(db: Db, row: BankAuditInsert): Promise<void> {
  await db.insert(bankAuditLog).values({
    holdingId: row.holdingId ?? null,
    holderCharacterId: row.holderCharacterId,
    itemName: row.itemName,
    action: row.action,
    source: row.source,
    changedBy: row.changedBy,
    before: row.before,
    after: row.after,
    note: row.note ?? null,
    batchId: row.batchId ?? null,
  });
}

// D1 caps a statement at 100 bound parameters; each row binds 7
// (holdingId, holderCharacterId, itemName, action, source, changedBy,
// before, after is actually 8) — 10/chunk (80 params) matches this
// codebase's other chunk sizes (sync.ts's INSERT_CHUNK_SIZE/
// DESIGNATION_CHUNK_SIZE) with real headroom.
const AUDIT_CHUNK_SIZE = 10;

// For inclusion in an existing db.batch() — applySync's per-holder write.
// Chunked into the SAME batch as that holder's holdings delete+insert, so
// the audit trail commits atomically with what it describes rather than
// being a separate best-effort write after the fact.
export function bankAuditStatements(db: Db, rows: BankAuditInsert[]): BatchItem<"sqlite">[] {
  const statements: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < rows.length; i += AUDIT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + AUDIT_CHUNK_SIZE);
    statements.push(
      db.insert(bankAuditLog).values(
        chunk.map((row) => ({
          holdingId: row.holdingId ?? null,
          holderCharacterId: row.holderCharacterId,
          itemName: row.itemName,
          action: row.action,
          source: row.source,
          changedBy: row.changedBy,
          before: row.before,
          after: row.after,
          note: row.note ?? null,
          batchId: row.batchId ?? null,
        })),
      ),
    );
  }
  return statements;
}

export type BankAuditRow = {
  id: number;
  holderCharacterId: number;
  holderName: string;
  itemName: string;
  action: BankAuditAction;
  source: BankAuditSource;
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  batchId: string | null;
};

// One line on the Audit tab — either a real multi-row batch (a sync, or a
// bulk "remove unverified item" pass — see sync.ts/actions.ts) collapsed to
// a summary with its rows available to expand, or a single one-off event
// (a manual add/edit/delete) shown with rows === [that one row] and no
// expand affordance the table needs to render. 2026-09-27 officer feedback:
// "if a user adds an entire bag ... this gets messy ... its just a lot of
// entries" — correct, per-item audit trail, just collapsed for readability.
export type BankAuditBatch = {
  batchId: string | null;
  changedAt: Date;
  holderCharacterId: number;
  holderName: string;
  source: BankAuditSource;
  changedByName: string | null;
  summary: { created: number; updated: number; removed: number; verified: number };
  rows: BankAuditRow[];
};

function toBankAuditRow(r: {
  id: number;
  holderCharacterId: number;
  holderName: string;
  itemName: string;
  action: string;
  source: string;
  changedAt: Date;
  changedByName: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  batchId: string | null;
}): BankAuditRow {
  return { ...r, action: r.action as BankAuditAction, source: r.source as BankAuditSource };
}

// Backs /bank's Audit tab — officer/leader/admin only as of 2026-09-27
// (epgp.bank.audit.view; was member-visible, matching the EPGP ledger's
// Audit Trail — reverted per Jason's own call: "for now lets leave this as
// visible to only officers, guild leaders and admin," with a note that
// member visibility may return later. That's a one-capability-default
// change in capabilities.ts, not anything hardcoded here). No join through
// JSON needed (unlike ledgerAuditLog's audit tab) since holderCharacterId/
// itemName are real denormalized columns, not buried in before/after.
export async function listBankAuditLog(
  db: Db,
  opts: { q?: string; page: number; pageSize: number },
): Promise<{ batches: BankAuditBatch[]; hasNext: boolean }> {
  const term = opts.q?.trim().toLowerCase();
  const changedByName = sql<string | null>`coalesce(
    (select c.name from players p join characters c on c.id = p.main_character_id where p.user_id = ${users.id} limit 1),
    ${users.username}
  )`;
  const where = term
    ? or(
        like(sql`lower(${characters.name})`, `%${term}%`),
        like(sql`lower(${bankAuditLog.itemName})`, `%${term}%`),
        like(sql`lower(coalesce(${changedByName}, ''))`, `%${term}%`),
        like(sql`lower(${bankAuditLog.action})`, `%${term}%`),
        like(sql`lower(${bankAuditLog.source})`, `%${term}%`),
        like(sql`lower(coalesce(${bankAuditLog.note}, ''))`, `%${term}%`),
      )
    : undefined;

  // A search narrows to matching individual rows, shown flat (one
  // singleton "batch" per matching row) rather than grouped — batching a
  // filtered subset of a sync's rows would show a misleading partial
  // summary ("2 verified" when the sync actually verified 380), and the
  // whole point of a search here is finding one specific item/event, not
  // browsing. The unfiltered default view (no search term) is where
  // batching actually matters, and that's the common case.
  if (term) {
    const rows = await db
      .select({
        id: bankAuditLog.id,
        holderCharacterId: bankAuditLog.holderCharacterId,
        holderName: characters.name,
        itemName: bankAuditLog.itemName,
        action: bankAuditLog.action,
        source: bankAuditLog.source,
        changedAt: bankAuditLog.changedAt,
        changedByName,
        before: bankAuditLog.before,
        after: bankAuditLog.after,
        note: bankAuditLog.note,
        batchId: bankAuditLog.batchId,
      })
      .from(bankAuditLog)
      .innerJoin(characters, eq(characters.id, bankAuditLog.holderCharacterId))
      .leftJoin(users, eq(bankAuditLog.changedBy, users.id))
      .where(and(where))
      .orderBy(desc(bankAuditLog.changedAt))
      .limit(opts.pageSize + 1)
      .offset((opts.page - 1) * opts.pageSize);

    const hasNext = rows.length > opts.pageSize;
    const page = rows.slice(0, opts.pageSize).map(toBankAuditRow);
    return {
      batches: page.map((r) => ({
        batchId: r.batchId,
        changedAt: r.changedAt,
        holderCharacterId: r.holderCharacterId,
        holderName: r.holderName,
        source: r.source,
        changedByName: r.changedByName,
        summary: {
          created: r.action === "create" ? 1 : 0,
          updated: r.action === "update" ? 1 : 0,
          removed: r.action === "delete" ? 1 : 0,
          verified: r.action === "verify" ? 1 : 0,
        },
        rows: [r],
      })),
      hasNext,
    };
  }

  // No search — paginate at the BATCH level (coalescing a null batch_id to
  // a synthetic per-row key so a one-off event is its own single-row
  // "batch") so a 400-row sync can never span multiple pages of the
  // pageSize+1-row lookahead this function's own pagination pattern uses
  // elsewhere (see ledger-list.ts / other list* functions in this repo).
  const batchKey = sql<string>`coalesce(${bankAuditLog.batchId}, 'row:' || ${bankAuditLog.id})`;
  const summaries = await db
    .select({
      batchKey,
      batchId: bankAuditLog.batchId,
      changedAt: sql<number>`max(${bankAuditLog.changedAt})`,
      holderCharacterId: bankAuditLog.holderCharacterId,
      holderName: characters.name,
      source: bankAuditLog.source,
      changedByName: sql<string | null>`max(${changedByName})`,
      created: sql<number>`sum(case when ${bankAuditLog.action} = 'create' then 1 else 0 end)`,
      updated: sql<number>`sum(case when ${bankAuditLog.action} = 'update' then 1 else 0 end)`,
      removed: sql<number>`sum(case when ${bankAuditLog.action} = 'delete' then 1 else 0 end)`,
      verified: sql<number>`sum(case when ${bankAuditLog.action} = 'verify' then 1 else 0 end)`,
    })
    .from(bankAuditLog)
    .innerJoin(characters, eq(characters.id, bankAuditLog.holderCharacterId))
    .leftJoin(users, eq(bankAuditLog.changedBy, users.id))
    .groupBy(batchKey, bankAuditLog.batchId, bankAuditLog.holderCharacterId, characters.name, bankAuditLog.source)
    .orderBy(desc(sql`max(${bankAuditLog.changedAt})`))
    .limit(opts.pageSize + 1)
    .offset((opts.page - 1) * opts.pageSize);

  const hasNext = summaries.length > opts.pageSize;
  const page = summaries.slice(0, opts.pageSize);

  const realBatchIds = page.map((b) => b.batchId).filter((id): id is string => id !== null);
  const singletonKeys = page.filter((b) => b.batchId === null).map((b) => b.batchKey);
  const singletonIds = singletonKeys.map((k) => Number(k.slice("row:".length)));

  const detailRows =
    realBatchIds.length === 0 && singletonIds.length === 0
      ? []
      : await db
          .select({
            id: bankAuditLog.id,
            holderCharacterId: bankAuditLog.holderCharacterId,
            holderName: characters.name,
            itemName: bankAuditLog.itemName,
            action: bankAuditLog.action,
            source: bankAuditLog.source,
            changedAt: bankAuditLog.changedAt,
            changedByName,
            before: bankAuditLog.before,
            after: bankAuditLog.after,
            note: bankAuditLog.note,
            batchId: bankAuditLog.batchId,
          })
          .from(bankAuditLog)
          .innerJoin(characters, eq(characters.id, bankAuditLog.holderCharacterId))
          .leftJoin(users, eq(bankAuditLog.changedBy, users.id))
          .where(
            or(
              realBatchIds.length > 0 ? inArray(bankAuditLog.batchId, realBatchIds) : undefined,
              singletonIds.length > 0 ? inArray(bankAuditLog.id, singletonIds) : undefined,
            ),
          )
          .orderBy(asc(bankAuditLog.id));

  const rowsByBatchKey = new Map<string, BankAuditRow[]>();
  for (const raw of detailRows) {
    const row = toBankAuditRow(raw);
    const key = row.batchId ?? `row:${row.id}`;
    const list = rowsByBatchKey.get(key) ?? [];
    list.push(row);
    rowsByBatchKey.set(key, list);
  }

  const batches: BankAuditBatch[] = page.map((b) => ({
    batchId: b.batchId,
    changedAt: new Date(b.changedAt * 1000),
    holderCharacterId: b.holderCharacterId,
    holderName: b.holderName,
    source: b.source as BankAuditSource,
    changedByName: b.changedByName,
    summary: { created: b.created, updated: b.updated, removed: b.removed, verified: b.verified },
    rows: rowsByBatchKey.get(b.batchKey) ?? [],
  }));

  return { batches, hasNext };
}
