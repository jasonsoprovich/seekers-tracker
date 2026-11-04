// Table-reference scanner for the read-only SQL sandbox
// (src/app/(app)/epgp/sql/actions.ts). Lives outside the "use server" file
// so scripts/verify-sql-sandbox.ts can exercise it directly.
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
      // A subquery's own FROM/JOIN gets found by the outer walk, so it can be
      // skipped. Anything else in parens is SQLite's parenthesized table list
      // — `FROM (accounts a)` is valid and reads the table with no FROM/JOIN
      // directly in front of it — so scan inside instead of skipping it.
      const first = tokens[i + 1];
      const isSubquery = first?.type === "ident" && ["select", "with", "values"].includes(first.value.toLowerCase());
      if (!isSubquery) scanRefList(tokens, i + 1, cteNames, bad);
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
    } else if (t.type === "quoted") {
      bad.ref ??= "(quoted identifier)";
      i++;
    } else {
      break;
    }
    // optional alias: `AS name` or a bare `name` — after a parenthesized
    // item too, or `FROM (SELECT 1) t, accounts a` stops at `t` and never
    // reaches the comma
    if (tokens[i]?.type === "ident" && (tokens[i] as { type: "ident"; value: string }).value.toLowerCase() === "as") {
      i++;
      if (tokens[i]?.type === "ident") i++;
    } else if (tokens[i]?.type === "ident" && !NOT_AN_ALIAS.has((tokens[i] as { type: "ident"; value: string }).value.toLowerCase())) {
      i++;
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

export function findDisallowedTableRef(body: string): string | null {
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

