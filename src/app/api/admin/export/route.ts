import { getCloudflareContext } from "@opennextjs/cloudflare";

import { getRealUserRole, LEADERSHIP_ROLES } from "@/lib/authz";
import { toCsvRow } from "@/lib/epgp/csv";
import { EXPORT_TABLES, getExportTable, type ExportTable } from "@/lib/export/tables";
import { guildDayBounds } from "@/lib/guild-timezone";
import { getSession } from "@/lib/session";

// Admin+leader-only CSV export — /admin/logs "Export" tab. Not
// requireOfficerApiKey (that's the parser app's own auth); this is a
// browser download gated the same way as the page that links here
// (getRealUserRole/LEADERSHIP_ROLES, same hard gate as /admin/permissions
// and /admin/logs — never matrix-tunable).
//
// Two modes on the same route:
//   ?count=1&tables=a,b,c[&from=&to=]  -> JSON row counts, for the panel's
//     "N rows" preview before a leader commits to a download.
//   ?table=a[&from=&to=]               -> one streamed CSV for that table.
// Deliberately one table per CSV download (no ZIP) — see
// src/lib/export/tables.ts's file comment / the plan doc for why.
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
  const realRole = await getRealUserRole(session.user.id);
  if (!realRole || !LEADERSHIP_ROLES.includes(realRole)) {
    return Response.json({ error: "Only leaders and admins can export data." }, { status: 403 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const { env } = await getCloudflareContext({ async: true });
  const d1 = env.DATABASE;

  if (url.searchParams.get("count") === "1") {
    const keys = (url.searchParams.get("tables") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    const counts: Record<string, number | null> = {};
    for (const key of keys) {
      const table = getExportTable(key);
      if (!table) {
        counts[key] = null;
        continue;
      }
      const { clause, binds } = dateFilter(table, from, to);
      const stmt = d1.prepare(`SELECT count(*) AS n FROM ${table.table}${clause ? ` WHERE ${clause}` : ""}`).bind(...binds);
      const row = await stmt.first<{ n: number }>();
      counts[key] = row?.n ?? 0;
    }
    return Response.json(counts);
  }

  const tableKey = url.searchParams.get("table");
  const table = tableKey ? getExportTable(tableKey) : undefined;
  if (!table) {
    return Response.json({ error: `Unknown export table. Valid keys: ${EXPORT_TABLES.map((t) => t.key).join(", ")}` }, { status: 400 });
  }

  const stream = buildCsvStream(d1, table, from, to);
  const filename = `seekers-${table.key}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

// Binds `from`/`to` (guild-local 'YYYY-MM-DD') against a table's date
// column, or returns no clause for a table with none (dateColumn: null).
// "timestamp" columns store unix-epoch SECONDS (unixepoch() default,
// matching every other epoch-bound query in this app — see raids.ts's
// reverseRaid); "text-date" is the one exception, raids.raid_date, a plain
// 'YYYY-MM-DD' string compared lexicographically.
function dateFilter(table: ExportTable, from: string, to: string): { clause: string; binds: (string | number)[] } {
  if (!table.dateColumn || (!from && !to)) return { clause: "", binds: [] };
  const parts: string[] = [];
  const binds: (string | number)[] = [];

  if (table.dateColumnType === "text-date") {
    if (from) { parts.push(`${table.dateColumn} >= ?`); binds.push(from); }
    if (to) { parts.push(`${table.dateColumn} <= ?`); binds.push(to); }
  } else {
    const fromBounds = from ? guildDayBounds(from) : null;
    const toBounds = to ? guildDayBounds(to) : null;
    if (fromBounds) { parts.push(`${table.dateColumn} >= ?`); binds.push(Math.floor(fromBounds.start.getTime() / 1000)); }
    if (toBounds) { parts.push(`${table.dateColumn} < ?`); binds.push(Math.floor(toBounds.end.getTime() / 1000)); }
  }
  return { clause: parts.join(" AND "), binds };
}

const PAGE_ROWS = 1000;

// Streams the table page by page (D1Database.prepare().all() still
// buffers one page in memory, never the whole table — the worst case here
// is ep_ledger at ~41k rows, so 1000-row pages keep peak memory small and
// keep every bound statement well under D1's 100-parameter cap, CLAUDE.md).
// Keyset pagination on SQLite's implicit `rowid` rather than each table's
// own primary key — every table here is a normal rowid table (none
// WITHOUT ROWID), so this needs no per-table knowledge of composite/
// missing primary keys (character_pop_flags, role_permissions, etc.).
function buildCsvStream(d1: D1Database, table: ExportTable, from: string, to: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { clause: dateClause, binds: dateBinds } = dateFilter(table, from, to);
  const selectList = table.columns ? table.columns.join(", ") : "*";
  let cursor = 0;
  let wroteHeader = false;

  return new ReadableStream({
    async pull(controller) {
      const where = [dateClause, "rowid > ?"].filter(Boolean).join(" AND ");
      const stmt = d1
        .prepare(`SELECT rowid AS __rowid, ${selectList} FROM ${table.table} WHERE ${where} ORDER BY rowid LIMIT ?`)
        .bind(...dateBinds, cursor, PAGE_ROWS);
      const { results } = await stmt.all<Record<string, unknown>>();

      if (!wroteHeader) {
        const headerCols = results.length > 0 ? Object.keys(results[0]).filter((c) => c !== "__rowid") : (table.columns ?? []);
        controller.enqueue(encoder.encode(toCsvRow(headerCols)));
        wroteHeader = true;
      }

      if (results.length === 0) {
        controller.close();
        return;
      }

      for (const row of results) {
        const { __rowid, ...rest } = row;
        cursor = __rowid as number;
        controller.enqueue(encoder.encode(toCsvRow(Object.values(rest))));
      }

      if (results.length < PAGE_ROWS) controller.close();
    },
  });
}
