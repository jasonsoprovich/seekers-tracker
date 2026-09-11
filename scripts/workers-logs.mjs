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

const filters = [{ key: "$metadata.service", operation: "eq", value: "seekers-tracker", type: "string" }];
if (level) filters.push({ key: "$metadata.level", operation: "eq", value: level, type: "string" });

const body = {
  queryId: `adhoc-${now}`,
  timeframe: { from: now - hours * 3600e3, to: now },
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
  const m = e.$metadata ?? {};
  const src = e.source ?? {};
  const req = src.request ?? {};
  const path = String(req.url ?? "").replace(/^https?:\/\/[^/]+/, "");
  const msg = m.message ?? (src.message ? JSON.stringify(src.message) : "");
  console.log(
    `${new Date(e.timestamp).toISOString()} ${String(m.level ?? "").padEnd(5)} ${String(req.method ?? "").padEnd(4)} ${path} st=${src.response?.status ?? "-"} wall=${src.wallTimeMs ?? "-"} :: ${String(msg).slice(0, 240)}`,
  );
}
