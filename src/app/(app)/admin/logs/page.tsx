import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ExportPanel } from "@/components/admin/ExportPanel";
import { SystemLogTable, type SystemLogRow } from "@/components/admin/SystemLogTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { fieldClasses } from "@/components/ui/Field";
import { systemEventLog } from "@/db";
import { getRealUserRole, LEADERSHIP_ROLES } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { EXPORT_TABLES } from "@/lib/export/tables";
import { guildDayBounds } from "@/lib/guild-timezone";
import { getSession } from "@/lib/session";
import { isSystemEventCategory, SYSTEM_EVENT_CATEGORIES } from "@/lib/system-log";

const PAGE_SIZE = 50;

type TabType = "log" | "export";
type SearchParams = { tab?: string; q?: string; category?: string; from?: string; to?: string; page?: string };

// Admin+leader only, hard-coded — same posture as /admin/permissions
// (LEADERSHIP_ROLES, never a matrix-tunable capability): the debugging
// System Log and raw data Export are surfaces this app deliberately never
// exposes to officers or members, and mustn't be toggleable into view by a
// permissions-matrix edit. See src/db/schema.ts's systemEventLog comment
// for what this table covers and doesn't.
export default async function AdminLogsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const realRole = await getRealUserRole(session.user.id);
  if (!realRole || !LEADERSHIP_ROLES.includes(realRole)) redirect("/admin");

  const { tab: tabParam, q = "", category: categoryParam, from = "", to = "", page: pageParam } = await searchParams;
  const tab: TabType = tabParam === "export" ? "export" : "log";
  const page = Math.max(1, Number(pageParam) || 1);
  const term = q.trim();
  const category = categoryParam && isSystemEventCategory(categoryParam) ? categoryParam : null;

  function pageHref(overrides: { tab?: TabType; page?: number }) {
    const params = new URLSearchParams();
    params.set("tab", overrides.tab ?? tab);
    if (term) params.set("q", term);
    if (category) params.set("category", category);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(overrides.page ?? page));
    return `/admin/logs?${params.toString()}`;
  }

  let rows: SystemLogRow[] = [];
  let hasNext = false;

  if (tab === "log") {
    const db = await getDb();
    const conditions = [];
    if (category) conditions.push(eq(systemEventLog.category, category));
    if (term) {
      const like_ = `%${term.toLowerCase()}%`;
      conditions.push(
        or(
          like(sql`lower(${systemEventLog.summary})`, like_),
          like(sql`lower(coalesce(${systemEventLog.actorLabel}, ''))`, like_),
          like(sql`lower(coalesce(${systemEventLog.targetLabel}, ''))`, like_),
          like(sql`lower(${systemEventLog.action})`, like_),
        ),
      );
    }
    // Dates are guild-local calendar days, same convention as raid
    // reversal (guildDayBounds) — "Sept 7" means the same day here as it
    // does on /epgp/raids, not a UTC-midnight boundary.
    const fromBounds = from ? guildDayBounds(from) : null;
    const toBounds = to ? guildDayBounds(to) : null;
    if (fromBounds) conditions.push(gte(systemEventLog.occurredAt, fromBounds.start));
    if (toBounds) conditions.push(lt(systemEventLog.occurredAt, toBounds.end));

    const found = await db
      .select()
      .from(systemEventLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(systemEventLog.occurredAt))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE);
    hasNext = found.length > PAGE_SIZE;
    rows = found.slice(0, PAGE_SIZE);
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin" }]}
        title="System Log & Export"
        subtitle="A detailed, admin/leader-only record of every non-parser database change, plus CSV export of any table. Not visible to members or officers."
      />

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["log", "export"] as const).map((t) => (
            <Link
              key={t}
              href={pageHref({ tab: t, page: 1 })}
              prefetch={false}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-accent text-black" : "border border-field text-neutral-300 hover:bg-neutral-900/60"}`}
            >
              {t === "log" ? "System Log" : "Export"}
            </Link>
          ))}
        </div>

        {tab === "log" && (
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="log" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">Search</span>
              <input type="text" name="q" defaultValue={term} placeholder="Actor, target, action…" className={`${fieldClasses({ size: "sm" })} w-48`} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">Category</span>
              <select name="category" defaultValue={category ?? ""} className={fieldClasses({ size: "sm" })}>
                <option value="">All</option>
                {SYSTEM_EVENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">From</span>
              <input type="date" name="from" defaultValue={from} className={fieldClasses({ size: "sm" })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">To</span>
              <input type="date" name="to" defaultValue={to} className={fieldClasses({ size: "sm" })} />
            </label>
            <button type="submit" className="rounded-md border border-field px-3 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-900/60">
              Filter
            </button>
          </form>
        )}
      </div>

      <div className="mt-4">
        {tab === "log" && <SystemLogTable rows={rows} />}
        {tab === "export" && <ExportPanel tables={EXPORT_TABLES} />}
      </div>

      {tab === "log" && (
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
