// Always-on D1 watchdog (2026-09-11). Workers Logs showed requests from
// THREE different members' networks (Edmonton/TELUS, Las Vegas/Cox, New
// York/Starlink) hanging server-side for 40s to 100 minutes with outcome
// "canceled" and no log lines at all — pages (/roster, /dashboard,
// /epgp/ledger, /bank, /characters/[id]/account), the officer API
// (/api/officer/items from the parser) and the Discord login callback
// alike. The one thing every hung route has in common is D1 through
// drizzle / better-auth. Every statement issued through getDb() and the
// auth adapter passes through here: one that hasn't returned after HANG_MS
// logs `[hang] D1 <op> <sql>` while it is still pending, so the next
// occurrence names the statement instead of leaving us guessing. Cost on
// the normal path: one setTimeout + clearTimeout per statement.
const HANG_MS = 10_000;

const wrappedDbs = new WeakMap<D1Database, D1Database>();
// batch() must receive the REAL statements — map each wrapper back.
const realStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

function watch<T>(label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const timer = setTimeout(() => console.warn(`[hang] D1 ${label} still running after ${HANG_MS}ms`), HANG_MS);
  return p.finally(() => {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (ms >= HANG_MS) console.warn(`[hang] D1 ${label} finished after ${ms}ms`);
  });
}

function wrapStatement(real: D1PreparedStatement, sqlText: string): D1PreparedStatement {
  const short = sqlText.replace(/\s+/g, " ").slice(0, 160);
  const wrapped = {
    bind: (...values: unknown[]) => wrapStatement(real.bind(...values), sqlText),
    first: (colName?: string) => watch(`first ${short}`, colName === undefined ? real.first() : real.first(colName)),
    run: () => watch(`run ${short}`, real.run()),
    all: () => watch(`all ${short}`, real.all()),
    raw: (options?: { columnNames?: boolean }) => watch(`raw ${short}`, real.raw(options as { columnNames?: false })),
  } as unknown as D1PreparedStatement;
  realStatements.set(wrapped, real);
  return wrapped;
}

export function watchD1(db: D1Database): D1Database {
  const existing = wrappedDbs.get(db);
  if (existing) return existing;
  const wrapped = {
    prepare: (query: string) => wrapStatement(db.prepare(query), query),
    batch: <T,>(statements: D1PreparedStatement[]) =>
      watch(`batch(${statements.length})`, db.batch<T>(statements.map((s) => realStatements.get(s) ?? s))),
    exec: (query: string) => watch(`exec ${query.replace(/\s+/g, " ").slice(0, 160)}`, db.exec(query)),
    withSession: (constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  } as unknown as D1Database;
  wrappedDbs.set(db, wrapped);
  return wrapped;
}
