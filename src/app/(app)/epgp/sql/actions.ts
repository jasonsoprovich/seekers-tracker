"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { redirect } from "next/navigation";

import { canManageEpgp, getUserRole } from "@/lib/authz";
import { getSession } from "@/lib/session";

export type SqlQueryResult = {
  columns?: string[];
  rows?: Record<string, unknown>[];
  error?: string;
  query?: string;
};

// Whole-word match so this doesn't false-positive on things like a
// character literally bidding on an item called "Insert" — unlikely, but
// cheap to get right.
const BANNED_KEYWORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|begin|commit|rollback)\b/i;

// Read-only SQL sandbox (officer/leader/admin — see the EPGP plan's "SQL
// tool scope" decision). Defense in depth, not just a keyword filter:
// 1. Reject anything but a single statement (no `;` before the very end).
// 2. Require it to start with SELECT/WITH.
// 3. Reject banned DML/DDL/pragma keywords outright.
// 4. Reject SQL comments (`--`, `/* */`) — without this, a query like
//    `SELECT 1) UNION SELECT sql FROM sqlite_master -- ` comments out the
//    wrapper's closing `)` and `LIMIT 200` below, defeating guarantee #5.
//    Ad-hoc debugging queries have no legitimate need for a comment.
// 5. Wrap the whole thing as `SELECT * FROM (<query>) LIMIT 200` — this is
//    the actual guarantee: even if 1-4 miss something, only a single
//    read-only expression can be wrapped this way, and the row cap always
//    applies regardless of what LIMIT (if any) the user wrote.
export async function runEpgpQuery(_prev: SqlQueryResult, formData: FormData): Promise<SqlQueryResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageEpgp(role)) {
    return { error: "Only officers, leaders, and admins can use the SQL sandbox." };
  }

  const raw = String(formData.get("query") ?? "").trim();
  if (!raw) return { error: "Enter a query." };

  const semicolonAt = raw.indexOf(";");
  if (semicolonAt !== -1 && semicolonAt !== raw.length - 1) {
    return { error: "Only a single statement is allowed — remove the extra `;`.", query: raw };
  }
  const body = raw.endsWith(";") ? raw.slice(0, -1).trim() : raw;

  if (!/^(select|with)\b/i.test(body)) {
    return { error: "Only SELECT (or WITH ... SELECT) queries are allowed.", query: raw };
  }
  if (BANNED_KEYWORDS.test(body)) {
    return { error: "That query contains a disallowed keyword — this sandbox is read-only.", query: raw };
  }
  if (body.includes("--") || body.includes("/*")) {
    return { error: "Comments (-- or /* */) aren't allowed — they can hide the end of the query.", query: raw };
  }

  const { env } = await getCloudflareContext({ async: true });
  try {
    const wrapped = `SELECT * FROM (${body}) LIMIT 200`;
    const result = await env.DATABASE.prepare(wrapped).all();
    const rows = (result.results ?? []) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, query: raw };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Query failed.", query: raw };
  }
}
