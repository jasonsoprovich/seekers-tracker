// Query Workers Logs (the dashboard's Observability > Logs) from the shell,
// so a "site froze at 9:35pm" report can be checked against what the
// Worker actually saw, hours later — `wrangler tail` only shows live
// traffic. Needs SEEKERS_CF_LOGS_TOKEN in the environment: an API token
// with "Workers Observability: Read" (Account > Workers Observability).
// Deliberately NOT named CLOUDFLARE_API_TOKEN — wrangler would pick that
// up in place of the browser login, and a logs-only token can't deploy or
// touch D1. Set it once in ~/.zshenv (see README).
//
//   node scripts/workers-logs.mjs [hours] [needle] [level]
//     hours   look back this many hours (default 24)
//     needle  substring to search for, e.g. "[slow]" or "[auth]" (default: none)
//     level   error | warn | info | log (default: any)
//   LIMIT=500 raises the event cap (default 100).
//   WALL_GT=5000 keeps only invocations slower than 5s.
//   FROM=2026-09-11T03:25:00Z TO=2026-09-11T03:40:00Z queries a window
//   instead of "last N hours". RAW=1 prints each event as JSON.
//
// Prints one line per event: time, level, method, path, status, wall ms,
// message. Same query endpoint the dashboard uses.
const token = process.env.SEEKERS_CF_LOGS_TOKEN;
if (!token) {
  console.error("SEEKERS_CF_LOGS_TOKEN is not set (add `export SEEKERS_CF_LOGS_TOKEN=...` to ~/.zshenv)");
  process.exit(1);
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "a12d86f29792323791c2fdc101759089";
const hours = Number(process.argv[2] ?? 24);
const needle = process.argv[3] || null;
const level = process.argv[4] || null;
const now = Date.now();
const from = process.env.FROM ? Date.parse(process.env.FROM) : now - hours * 3600e3;
const to = process.env.TO ? Date.parse(process.env.TO) : now;

const filters = [{ key: "$metadata.service", operation: "eq", value: "seekers-tracker", type: "string" }];
if (level) filters.push({ key: "$metadata.level", operation: "eq", value: level, type: "string" });
// WALL_GT=5000 keeps only invocations whose wall time exceeded N ms.
if (process.env.WALL_GT) filters.push({ key: "$workers.wallTimeMs", operation: "gt", value: Number(process.env.WALL_GT), type: "number" });

const body = {
  queryId: `adhoc-${now}`,
  timeframe: { from, to },
  view: "events",
  limit: Number(process.env.LIMIT ?? 100),
  dry: true,
  parameters: {
    datasets: ["cloudflare-workers"],
    filters,
    calculations: [],
    groupBys: [],
    ...(needle ? { needle: { value: needle, matchCase: false, isRegex: false } } : {}),
  },
};

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const json = await res.json();
if (!json.success) {
  console.error(JSON.stringify(json.errors ?? json, null, 2));
  process.exit(1);
}
const events = json.result?.events?.events ?? [];
console.log(`${events.length} events (of ${json.result?.events?.count ?? "?"}) in the last ${hours}h${needle ? ` matching "${needle}"` : ""}${level ? ` at level ${level}` : ""}`);
for (const e of events) {
  if (process.env.RAW) {
    console.log(JSON.stringify(e));
    continue;
  }
  const m = e.$metadata ?? {};
  const w = e.$workers ?? {};
  const ev = w.event ?? {};
  const req = ev.request ?? {};
  const path = ev.path ?? String(req.url ?? "").replace(/^https?:\/\/[^/]+/, "");
  const warm = req.headers?.["x-warm"] ? " warm" : "";
  const proto = req.cf?.httpProtocol ? ` ${req.cf.httpProtocol}` : "";
  const cookie = req.headers?.cookie?.includes("better-auth.session") ? " cookie" : "";
  const msg = e.source?.message ?? m.message ?? "";
  console.log(
    `${new Date(e.timestamp).toISOString()} ${String(m.level ?? e.source?.level ?? "").padEnd(5)} ${String(w.eventType ?? "").padEnd(9)} ${String(w.outcome ?? "").padEnd(9)} ${String(req.method ?? "").padEnd(4)} ${path} st=${ev.response?.status ?? "-"} wall=${w.wallTimeMs ?? "-"}${proto}${cookie}${warm} :: ${String(msg).slice(0, 200)}`,
  );
}
