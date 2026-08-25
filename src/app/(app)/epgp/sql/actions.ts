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

// Tables this sandbox must never let a query reach, even indirectly through
// a view or a subquery — better-auth's own tables (session/OAuth tokens,
// hashed API keys) plus Toryn's raw-Discord-ID staging dump.
const FORBIDDEN_TABLES = ["sessions", "accounts", "apikeys", "verifications", "sos_bot_staging"];
const FORBIDDEN_TABLES_RE = new RegExp(`\\b(${FORBIDDEN_TABLES.join("|")})\\b`, "i");

// --- Table-reference scanner -------------------------------------------
//
// A real tokenizer, not a couple of regexes — a regex-only version of this
// was tried first and confirmed (empirically, against local D1) to miss the
// old-style comma-join case: `FROM v_characters c, accounts a` doesn't put
// "accounts" right after FROM or JOIN, so a naive "keyword then identifier"
// regex never sees it. Tokenizing first and then walking every token means
// every FROM/JOIN occurrence — including ones inside a subquery, a CTE
// body, or after a comma — gets found the same way, because the walk
// doesn't try to track "where in the grammar am I," it just asks "is this
// token literally FROM or JOIN?" for every token in the query and, if so,
// parses the comma-separated table-ref-list that follows it.
type Token =
  | { type: "ident"; value: string }
  | { type: "string" | "quoted" | "number" | "other" }
  | { type: "("; }
  | { type: ")"; }
  | { type: ","; }
  | { type: "."; };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      // string literal, '' is an escaped quote
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) {
        i += sql[i] === "'" && sql[i + 1] === "'" ? 2 : 1;
      }
      i++; // closing quote
      tokens.push({ type: "string" });
    } else if (c === '"' || c === "`" || c === "[") {
      // quoted/bracketed identifier — opaque; the caller rejects any use of
      // one as a table reference outright rather than trying to read it.
      const close = c === "[" ? "]" : c;
      i++;
      while (i < sql.length && sql[i] !== close) i++;
      i++;
      tokens.push({ type: "quoted" });
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      tokens.push({ type: "ident", value: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ type: "number" });
      i = j;
    } else if (c === "(") {
      tokens.push({ type: "(" });
      i++;
    } else if (c === ")") {
      tokens.push({ type: ")" });
      i++;
    } else if (c === ",") {
      tokens.push({ type: "," });
      i++;
    } else if (c === ".") {
      tokens.push({ type: "." });
      i++;
    } else {
      tokens.push({ type: "other" });
      i++;
    }
  }
  return tokens;
}

// Words that can legitimately follow a table-ref where a bare alias would
// otherwise be expected — if the next identifier is one of these, it's part
// of the surrounding clause, not an alias, so don't consume it as one.
const NOT_AN_ALIAS = new Set([
  "where", "group", "order", "limit", "having", "union", "intersect", "except",
  "on", "using", "join", "inner", "outer", "left", "right", "full", "cross",
  "natural", "window", "as",
]);

function skipBalancedParens(tokens: Token[], openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  for (; i < tokens.length; i++) {
    if (tokens[i].type === "(") depth++;
    else if (tokens[i].type === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

// Parses the comma-separated table-ref-list starting at `start` (the token
// right after a FROM/JOIN keyword) and records any disallowed reference it
// finds into `bad`. Returns nothing useful — callers only care about `bad`,
// since every FROM/JOIN occurrence in the whole query gets its own call
// from findDisallowedTableRef's outer walk regardless of nesting depth.
function scanRefList(tokens: Token[], start: number, cteNames: Set<string>, bad: { ref: string | null }): void {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "(") {
      i = skipBalancedParens(tokens, i);
    } else if (t.type === "ident") {
      let tableName = t.value;
      i++;
      if (tokens[i]?.type === "." && tokens[i + 1]?.type === "ident") {
        tableName = (tokens[i + 1] as { type: "ident"; value: string }).value;
        i += 2;
      }
      if (!tableName.toLowerCase().startsWith("v_") && !cteNames.has(tableName.toLowerCase())) {
        bad.ref ??= tableName;
      }
      // optional alias: `AS name` or a bare `name`
      if (tokens[i]?.type === "ident" && (tokens[i] as { type: "ident"; value: string }).value.toLowerCase() === "as") {
        i++;
        if (tokens[i]?.type === "ident") i++;
      } else if (tokens[i]?.type === "ident" && !NOT_AN_ALIAS.has((tokens[i] as { type: "ident"; value: string }).value.toLowerCase())) {
        i++;
      }
    } else if (t.type === "quoted") {
      bad.ref ??= "(quoted identifier)";
      i++;
    } else {
      break;
    }
    if (tokens[i]?.type === ",") {
      i++;
      continue;
    }
    break;
  }
}

function collectCteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    // `name AS (` — the only construct in valid SQLite grammar where a bare
    // identifier is directly followed by AS directly followed by an open
    // paren, so this is unambiguous without needing to first locate WITH.
    if (
      tokens[i].type === "ident" &&
      tokens[i + 1]?.type === "ident" &&
      (tokens[i + 1] as { type: "ident"; value: string }).value.toLowerCase() === "as" &&
      tokens[i + 2]?.type === "("
    ) {
      names.add((tokens[i] as { type: "ident"; value: string }).value.toLowerCase());
    }
  }
  return names;
}

function findDisallowedTableRef(body: string): string | null {
  const tokens = tokenize(body);
  const cteNames = collectCteNames(tokens);
  const bad: { ref: string | null } = { ref: null };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "ident" && (t.value.toLowerCase() === "from" || t.value.toLowerCase() === "join")) {
      scanRefList(tokens, i + 1, cteNames, bad);
      if (bad.ref !== null) return bad.ref;
    }
  }
  return null;
}

// Read-only SQL sandbox (officer/leader/admin — see the EPGP plan's "SQL
// tool scope" decision, and authz.ts's canManageEpgp comment: "run
// read-only SQL against the EPGP tables"). That scope used to be aspirational
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
