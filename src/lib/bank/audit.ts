import { and, desc, eq, like, or, sql } from "drizzle-orm";
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

export type BankAuditAction = "create" | "update" | "delete";
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
};

// Backs /bank's Audit tab — member-visible, same transparency posture as
// the EPGP ledger's Audit Trail (CLAUDE.md, 2026-08-25: "every role, not
// just officer+"). No join through JSON needed (unlike ledgerAuditLog's
// audit tab) since holderCharacterId/itemName are real denormalized
// columns, not buried in before/after.
export async function listBankAuditLog(
  db: Db,
  opts: { q?: string; page: number; pageSize: number },
): Promise<{ rows: BankAuditRow[]; hasNext: boolean }> {
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
      )
    : undefined;

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
    })
    .from(bankAuditLog)
    .innerJoin(characters, eq(characters.id, bankAuditLog.holderCharacterId))
    .leftJoin(users, eq(bankAuditLog.changedBy, users.id))
    .where(where ? and(where) : undefined)
    .orderBy(desc(bankAuditLog.changedAt))
    .limit(opts.pageSize + 1)
    .offset((opts.page - 1) * opts.pageSize);

  const hasNext = rows.length > opts.pageSize;
  return {
    rows: rows.slice(0, opts.pageSize).map((r) => ({ ...r, action: r.action as BankAuditAction, source: r.source as BankAuditSource })),
    hasNext,
  };
}
