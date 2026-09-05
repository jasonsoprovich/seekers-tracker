import { and, asc, desc, eq, isNotNull, like, or, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AddLedgerEntryForm } from "@/components/epgp/AddLedgerEntryForm";
import { AuditLogTable, type AuditLogRow } from "@/components/epgp/AuditLogTable";
import { BidHistoryTable } from "@/components/epgp/BidHistoryTable";
import { LedgerTable, type EpRow, type GpRow } from "@/components/epgp/LedgerTable";
import { TotalsTable } from "@/components/epgp/TotalsTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { fieldClasses } from "@/components/ui/Field";
import { characters, epgpPointValues, gpLedger, ledgerAuditLog, users } from "@/db";
import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getTotalsRows, listBidHistory, listLedgerRows } from "@/lib/epgp/ledger-list";
import { getSession } from "@/lib/session";

const PAGE_SIZE = 50;

type TabType = "totals" | "ep" | "gp" | "bids" | "audit";
type SearchParams = { type?: string; q?: string; page?: string };

const TABS: { key: TabType; label: string; officerOnly?: boolean; searchPlaceholder?: string }[] = [
  { key: "totals", label: "Totals" },
  { key: "ep", label: "EP Ledger", searchPlaceholder: "Character or activity…" },
  { key: "gp", label: "GP Ledger", searchPlaceholder: "Character, item, or tier…" },
  { key: "bids", label: "Bids History", searchPlaceholder: "Character or item…" },
  { key: "audit", label: "Audit Trail", officerOnly: true, searchPlaceholder: "Character, officer, or action…" },
];

// The EP/GP Log tabs this replaces (47k/5.9k rows) — the first paginated
// list in the app (see the EPGP plan: everything else loads its whole
// table client-side, but that doesn't scale to tens of thousands of ledger
// rows). Plain GET-form + limit/offset rather than client-side state, to
// match this repo's server-component-first convention elsewhere. Grew from
// two tabs (EP/GP) to four 2026-08-25: Bids History (bids has been
// write-only since Phase 12 — this is its first read path) and Audit Trail
// (folded in from the standalone /epgp/ledger/audit route, now removed)
// join the same URL-addressable ?type=/?q=/?page= shape so every tab stays
// bookmarkable and paginated server-side, same as EP/GP always were.
export default async function EpgpLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  const canManage = canManageEpgp(role);

  const { type: typeParam, q = "", page: pageParam } = await searchParams;
  const requestedType: TabType =
    typeParam === "totals" || typeParam === "gp" || typeParam === "bids" || typeParam === "audit" ? typeParam : "ep";
  // Audit is officer+ only — hitting ?type=audit directly without the role
  // (or an old bookmark of the removed /epgp/ledger/audit route) falls back
  // to EP rather than erroring or exposing officer-only rows.
  const type: TabType = requestedType === "audit" && !canManage ? "ep" : requestedType;
  const page = Math.max(1, Number(pageParam) || 1);
  const term = q.trim();

  const db = await getDb();
  const visibleTabs = TABS.filter((t) => !t.officerOnly || canManage);

  function pageHref(overrides: { type?: TabType; q?: string; page?: number }) {
    const params = new URLSearchParams();
    params.set("type", overrides.type ?? type);
    const qVal = overrides.q ?? term;
    if (qVal) params.set("q", qVal);
    params.set("page", String(overrides.page ?? page));
    return `/epgp/ledger?${params.toString()}`;
  }

  // Add-entry form data — only needed on the EP/GP tabs, only for officers.
  let characterOptions: { id: number; name: string }[] = [];
  let activitySuggestions: string[] = [];
  let itemSuggestions: string[] = [];
  if (canManage && (type === "ep" || type === "gp")) {
    const [charRows, activityRows, itemRows] = await Promise.all([
      db.select({ id: characters.id, name: characters.name }).from(characters).orderBy(asc(characters.name)),
      db
        .select({ activity: epgpPointValues.activity })
        .from(epgpPointValues)
        .where(and(eq(epgpPointValues.kind, type), eq(epgpPointValues.retired, false)))
        .orderBy(asc(epgpPointValues.sortOrder)),
      db.selectDistinct({ itemName: gpLedger.itemName }).from(gpLedger).where(isNotNull(gpLedger.itemName)).orderBy(asc(gpLedger.itemName)),
    ]);
    characterOptions = charRows;
    activitySuggestions = activityRows.map((r) => r.activity);
    itemSuggestions = itemRows.map((r) => r.itemName).filter((n): n is string => n !== null);
  }

  let totalsRows: Awaited<ReturnType<typeof getTotalsRows>> = [];
  let epRows: EpRow[] = [];
  let gpRows: GpRow[] = [];
  let bidRows: Awaited<ReturnType<typeof listBidHistory>>["rows"] = [];
  let auditRows: AuditLogRow[] = [];
  let hasNext = false;

  if (type === "totals") {
    totalsRows = await getTotalsRows(db);
  } else if (type === "ep") {
    const result = await listLedgerRows(db, { kind: "ep", q: term, page, pageSize: PAGE_SIZE });
    epRows = result.rows;
    hasNext = result.hasNext;
  } else if (type === "gp") {
    const result = await listLedgerRows(db, { kind: "gp", q: term, page, pageSize: PAGE_SIZE });
    gpRows = result.rows;
    hasNext = result.hasNext;
  } else if (type === "bids") {
    const result = await listBidHistory(db, { q: term, page, pageSize: PAGE_SIZE });
    bidRows = result.rows;
    hasNext = result.hasNext;
  } else {
    const offset = (page - 1) * PAGE_SIZE;
    // The audited row's character id lives inside the before/after JSON
    // snapshot (before is '{}' on a create, so the character is in after) —
    // join characters through it so the name is both displayable and
    // searchable without a second round-trip.
    const auditCharId = sql<number | null>`coalesce(json_extract(${ledgerAuditLog.before}, '$.characterId'), json_extract(${ledgerAuditLog.after}, '$.characterId'))`;
    const auditWhere = term
      ? or(
          like(sql`lower(${characters.name})`, `%${term.toLowerCase()}%`),
          like(sql`lower(coalesce(${users.username}, ''))`, `%${term.toLowerCase()}%`),
          like(sql`lower(${ledgerAuditLog.action})`, `%${term.toLowerCase()}%`),
          like(sql`lower(${ledgerAuditLog.ledgerType})`, `%${term.toLowerCase()}%`),
        )
      : undefined;
    const rows = await db
      .select({
        id: ledgerAuditLog.id,
        ledgerType: ledgerAuditLog.ledgerType,
        ledgerId: ledgerAuditLog.ledgerId,
        action: ledgerAuditLog.action,
        changedAt: ledgerAuditLog.changedAt,
        changedByName: users.username,
        characterName: characters.name,
        before: ledgerAuditLog.before,
        after: ledgerAuditLog.after,
      })
      .from(ledgerAuditLog)
      .leftJoin(users, eq(ledgerAuditLog.changedBy, users.id))
      .leftJoin(characters, eq(characters.id, auditCharId))
      .where(auditWhere)
      .orderBy(desc(ledgerAuditLog.changedAt))
      .limit(PAGE_SIZE + 1)
      .offset(offset);
    hasNext = rows.length > PAGE_SIZE;
    auditRows = rows.slice(0, PAGE_SIZE);
  }

  const activeTab = TABS.find((t) => t.key === type)!;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="EPGP Ledger" subtitle="EP/GP transaction history, bid outcomes, and the edit trail behind them — everything that adds up to the standings on /roster." />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2">
          {visibleTabs.map((tab) => (
            <Link
              key={tab.key}
              href={pageHref({ type: tab.key, page: 1 })}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${type === tab.key ? "bg-accent text-black" : "border border-field text-neutral-300 hover:bg-neutral-900/60"}`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {activeTab.searchPlaceholder && (
          <form method="get" className="flex items-end gap-2">
            <input type="hidden" name="type" value={type} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">Search</span>
              <input type="text" name="q" defaultValue={term} placeholder={activeTab.searchPlaceholder} className={`${fieldClasses({ size: "sm" })} w-56`} />
            </label>
            <button type="submit" className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60">
              Search
            </button>
          </form>
        )}
      </div>

      {canManage && (type === "ep" || type === "gp") && (
        <div className="mt-4">
          <AddLedgerEntryForm type={type} characters={characterOptions} activitySuggestions={activitySuggestions} itemSuggestions={itemSuggestions} />
        </div>
      )}

      <div className="mt-4">
        {type === "totals" && <TotalsTable rows={totalsRows} />}
        {type === "ep" && <LedgerTable type="ep" rows={epRows} canManage={canManage} />}
        {type === "gp" && <LedgerTable type="gp" rows={gpRows} canManage={canManage} />}
        {type === "bids" && <BidHistoryTable rows={bidRows} />}
        {type === "audit" && <AuditLogTable rows={auditRows} />}
      </div>

      {type !== "totals" && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-neutral-500">Page {page}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={pageHref({ page: page - 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
                ← Prev
              </Link>
            )}
            {hasNext && (
              <Link href={pageHref({ page: page + 1 })} className="rounded-md border border-field px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900/60">
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
