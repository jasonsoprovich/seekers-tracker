"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { redirect } from "next/navigation";

import { getPermissions } from "@/lib/permissions";
import { findDisallowedTableRef } from "@/lib/sql-sandbox";
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

// Tables this sandbox must never let a query reach, even indirectly through
// a view or a subquery — better-auth's own tables (session/OAuth tokens,
// hashed API keys) plus Toryn's raw-Discord-ID staging dump.
const FORBIDDEN_TABLES = ["sessions", "accounts", "apikeys", "verifications", "sos_bot_staging"];
const FORBIDDEN_TABLES_RE = new RegExp(`\\b(${FORBIDDEN_TABLES.join("|")})\\b`, "i");

// Read-only SQL sandbox (officer/leader/admin — see the EPGP plan's "SQL
// tool scope" decision, and the "epgp.sql" capability's own description:
// "run read-only SQL against the EPGP tables"). That scope used to be aspirational
// only — this ran straight against env.DATABASE, which also holds
// better-auth's sessions/accounts/apikeys tables (session tokens, plaintext
// Discord OAuth tokens — see src/auth/index.ts's comment on why those aren't
// encrypted at rest). An officer could `SELECT token FROM sessions` or pull
// another member's OAuth tokens straight out. Fixed in migration 0023 by
// adding v_-prefixed read-only views over exactly the EPGP-relevant tables,
// with NO view over sessions/accounts/apikeys/verifications/sos_bot_staging.
//
// Defense in depth, six layers:
// 1. Reject anything but a single statement (no `;` before the very end).
// 2. Require it to start with SELECT/WITH.
// 3. Reject banned DML/DDL/pragma keywords outright.
// 4. Reject SQL comments (`--`, `/* */`) — without this, a query like
//    `SELECT 1) UNION SELECT sql FROM sqlite_master -- ` comments out the
//    wrapper's closing `)` and `LIMIT 200` below, defeating guarantee #6.
//    Ad-hoc debugging queries have no legitimate need for a comment.
// 5. THE ACTUAL GUARANTEE: findDisallowedTableRef tokenizes the query (a
//    real tokenizer — see its own comment for why a regex version of this
//    was tried and rejected) and walks every token, requiring every
//    FROM/JOIN table reference to be a v_-prefixed view or a query-local
//    CTE. This is what closes the hole a query-plan check can't: tested
//    directly against local D1, `EXPLAIN QUERY PLAN` substitutes an alias
//    for the real table name whenever one is given (`FROM accounts a`
//    reports "SCAN a", not "SCAN accounts") — so a plan-based check alone
//    is defeated by the simplest possible alias and cannot be the real
//    guarantee. Inspecting the query's own identifier tokens doesn't have
//    that gap, since it reads the table name directly off the FROM/JOIN
//    clause before any alias is applied.
// 6. Belt-and-suspenders, not the guarantee: also run EXPLAIN QUERY PLAN on
//    the wrapped query and reject if its plan mentions sessions/accounts/
//    apikeys/verifications/sos_bot_staging BY NAME. Since aliasing defeats
//    this (see #5), it only catches an un-aliased reference layer 5's
//    tokenizer might have missed due to a bug — real value, but don't
//    mistake it for a second independent boundary the way an earlier
//    version of this comment did.
// 7. Wrap the whole thing as `SELECT * FROM (<query>) LIMIT 200` — even if
//    1-6 miss something, only a single read-only expression can be wrapped
//    this way, and the row cap always applies regardless of what LIMIT (if
//    any) the user wrote.
export async function runEpgpQuery(_prev: SqlQueryResult, formData: FormData): Promise<SqlQueryResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("epgp.sql")) {
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
  const badRef = findDisallowedTableRef(body);
  if (badRef !== null) {
    return {
      error: `"${badRef}" isn't one of this sandbox's tables — query the v_-prefixed views instead (e.g. v_characters, v_ep_ledger, v_gp_ledger). Run without a FROM/JOIN target to see available views, or check the EPGP schema docs.`,
      query: raw,
    };
  }

  const { env } = await getCloudflareContext({ async: true });
  const wrapped = `SELECT * FROM (${body}) LIMIT 200`;

  try {
    const plan = await env.DATABASE.prepare(`EXPLAIN QUERY PLAN ${wrapped}`).all();
    const planText = ((plan.results ?? []) as Record<string, unknown>[]).map((r) => String(r.detail ?? "")).join(" | ");
    if (FORBIDDEN_TABLES_RE.test(planText)) {
      return { error: "That query would read a table outside this sandbox's scope.", query: raw };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Query failed.", query: raw };
  }

  try {
    const result = await env.DATABASE.prepare(wrapped).all();
    const rows = (result.results ?? []) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, query: raw };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Query failed.", query: raw };
  }
}
