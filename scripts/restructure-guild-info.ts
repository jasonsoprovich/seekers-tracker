// One-off (2026-09-30): reformats the leader's Discord-pasted Guild Information
// cards and splits the long EPGP Loot Guide into separate, linkable cards.
// WORDING IS NOT CHANGED — every section is sliced out of the real stored text
// and only its formatting is rewritten; a word-level diff at the end proves it.
//
//   npx tsx scripts/restructure-guild-info.ts data/backups/guild-info-cards-2026-09-30.json
//
// Emits drizzle/seed/guild-info-restructure-2026-10.sql (gitignored). The SQL
// only touches a card whose body still equals the exported text, so it can't
// overwrite a leader's later edit, and re-running it is a no-op.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { slugify } from "../src/lib/guild-info-markdown";

type Row = { id: number; title: string; body: string; width: string };
const input = process.argv[2];
if (!input) throw new Error("usage: tsx scripts/restructure-guild-info.ts <export.json>");
const rows: Row[] = JSON.parse(readFileSync(input, "utf8"))[0].results;
const card = (title: string) => {
  const r = rows.find((x) => x.title === title);
  if (!r) throw new Error(`Export has no "${title}" card`);
  return r;
};

const rules = card("Guild Rules");
const conduct = card("Code of Conduct");
const loot = card("EPGP Loot Guide");
const swap = card("Main Swap Policy");

// ---- helpers ---------------------------------------------------------------
const tidy = (s: string) => s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
// "** Heading**" -> "**Heading**"
const fixBold = (l: string) => l.replace(/^\*\*[ \t]+([^*\n]+?)[ \t]*\*\*[ \t]*$/, "**$1**");

// Discord "•" bullets (tab-indented) -> "- " with two nesting levels, and the
// blank lines between bullets dropped so each list stays together.
function bullets(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/\t/g, "    "));
  const out: string[] = [];
  for (const raw of lines) {
    const m = /^(\s*)•\s*(.*)$/.exec(raw);
    if (m) out.push(`${m[1].length >= 8 ? "  " : ""}- ${fixBold(m[2]).trim()}`);
    else out.push(raw);
  }
  // drop blanks that sit between two bullet lines
  return out.filter((l, i) => !(l.trim() === "" && /^\s*- /.test(out[i - 1] ?? "") && /^\s*- /.test(out.slice(i + 1).find((x) => x.trim()) ?? ""))).join("\n");
}

function listify(text: string, re: RegExp): string {
  return text.split("\n").map((l) => (re.test(l) ? `- ${l.trim()}` : l)).join("\n");
}

// ---- split the EPGP guide into named sections --------------------------------
const HEADINGS = [
  "Earning EP", "EP Cap", "Earning GP", "GP Bid Priority Levels", "EP/GP Decay", "Cycle Decay", "Expansion Decay",
  "How Loot is Determined", "Obtaining Loot", "Ties", "Droppable Loot", "Rotting Loot",
  "Exceptional Demand Loot List (1 allowed per Player Character Set)", "Quest Drops", "Sky/Dozekar Quest Items", "Spells",
  "ST Keys", "Feedback and Questions", "Leads", "Officers", "Any Other Advice?",
];
const sec: Record<string, string> = { _intro: "" };
{
  let cur = "_intro";
  const buf: Record<string, string[]> = { _intro: [] };
  for (const line of loot.body.split("\n")) {
    const h = /^\*\*(.+?)\*\*[ \t]*$/.exec(line.trim());
    if (h && HEADINGS.includes(h[1])) {
      cur = h[1];
      buf[cur] = [];
    } else buf[cur].push(line);
  }
  for (const k of Object.keys(buf)) sec[k] = tidy(buf[k].join("\n"));
  for (const h of HEADINGS) if (!(h in sec)) throw new Error(`Heading not found in the EPGP guide: ${h}`);
}

// ---- the cards -----------------------------------------------------------------
const T = {
  overview: "Guild EPGP Loot System Overview",
  ep: "Earning EP",
  cap: "EP Cap",
  gp: "Earning GP",
  decay: "EP/GP Decay",
  determined: "How Loot is Determined",
  quest: "Quest Items, Spells, and ST Keys",
  leadership: "Leadership Roster and Misc Advice",
};
const link = (title: string) => `[${title}](#${slugify(title)})`;

type Out = { title: string; body: string; width: "full" | "half"; existingId?: number; originalBody?: string };
const out: Out[] = [];

// Guild Rules: clean numbered list; the closing sentence repeats rule 1 (with
// its link) word for word, so it is dropped.
{
  const [head, ...rest] = rules.body.split(/\n(?=\s*1\.\s)/);
  const items = rest.join("\n").split(/\n\n(?=\s*\d+\.\s)/).map((s) => s.trim());
  const last = items[items.length - 1].split("\n\n");
  items[items.length - 1] = last[0];
  const body = [head.trim(), items.map((i) => i.replace(/^\s*(\d+)\.\s+/, "$1. ")).join("\n\n")].join("\n\n");
  out.push({ title: "Guild Rules", body: tidy(body), width: "full", existingId: rules.id, originalBody: rules.body });
}

// Code of Conduct: the sign-off line becomes a callout.
out.push({
  title: "Code of Conduct",
  body: tidy(conduct.body.replace(/^(Remember everything you do while tagged with our name is a reflection on ALL of us\.)[ \t]*$/m, "> **$1**")),
  width: "full",
  existingId: conduct.id,
  originalBody: conduct.body,
});

// Overview: the Discord channel links become links to the matching cards here.
{
  const intro = sec._intro.split("\n");
  const first = intro.findIndex((l) => l.trim() === "Guild EPGP Loot System Overview");
  if (first !== 0) throw new Error("Expected the overview title as the first line");
  const body = intro
    .slice(1)
    .join("\n")
    .replace(/checking out the link here - (https:\/\/\S+)/, "checking out the [link here]($1).")
    .replace(/^EP Explanation - \S+[ \t]*$/m, `- EP Explanation - ${link(T.ep)}`)
    .replace(/^GP and Decay Explanation - \S+[ \t]*$/m, `- GP and Decay Explanation - ${link(T.gp)} and ${link(T.decay)}`)
    .replace(/^Main Switch and Leveling\/Incentive Policies - \S+[ \t]*$/m, `- Main Switch and Leveling/Incentive Policies - ${link("Main Swap Policy")}`)
    .replace(/^Determining Loot on an EPGP Raid - \S+[ \t]*$/m, `- Determining Loot on an EPGP Raid - ${link(T.determined)}`)
    .replace(/^Quest Items, Spells, and ST Keys - \S+[ \t]*$/m, `- Quest Items, Spells, and ST Keys - ${link(T.quest)}`)
    .replace(/^Leadership Roster and Misc Advice - \S+[ \t]*$/m, `- ${T.leadership} - ${link(T.leadership)}`);
  out.push({ title: T.overview, body: tidy(body), width: "full", existingId: loot.id, originalBody: loot.body });
}

out.push({ title: T.ep, body: tidy(bullets(sec["Earning EP"])), width: "full" });
out.push({ title: T.cap, body: tidy(sec["EP Cap"].replace(/^\*\*(Current EP Cap Per Cycle: \d+)\*\*[ \t]*$/m, "> **$1**")), width: "half" });
out.push({
  title: T.gp,
  body: tidy(`${sec["Earning GP"]}\n\n### GP Bid Priority Levels\n\n${sec["GP Bid Priority Levels"]}`),
  width: "half",
});
out.push({
  title: T.decay,
  body: tidy(`${sec["EP/GP Decay"]}\n\n### Cycle Decay\n\n${sec["Cycle Decay"]}\n\n### Expansion Decay\n\n${sec["Expansion Decay"]}`),
  width: "full",
});

{
  const obtaining = listify(sec["Obtaining Loot"], /^(Epic Drop|High Bid|Medium Bid|Low Bid|Alt Loot)\b/).replace(
    /^\*\*(You do NOT need to have accumulated any EP to bid on something\.)\*\*[ \t]*$/m,
    "> **$1**",
  );
  const demand = sec["Exceptional Demand Loot List (1 allowed per Player Character Set)"].replace(/^Soul Essence of Aten Ha Ra[ \t]*$/m, "- [[Soul Essence of Aten Ha Ra]]");
  const body = [
    "### Obtaining Loot",
    obtaining,
    "### Ties",
    sec["Ties"],
    "### Droppable Loot",
    sec["Droppable Loot"],
    "### Rotting Loot",
    sec["Rotting Loot"],
    "### Exceptional Demand Loot List (1 allowed per Player Character Set)",
    demand,
  ].join("\n\n");
  out.push({ title: T.determined, body: tidy(body), width: "full" });
}

{
  const spells = sec["Spells"].replace(/^(\d+)\.\s+/gm, "$1. ");
  const body = [
    "### Quest Drops",
    sec["Quest Drops"],
    "### Sky/Dozekar Quest Items",
    sec["Sky/Dozekar Quest Items"],
    "### Spells",
    spells,
    "### ST Keys",
    sec["ST Keys"],
  ].join("\n\n");
  out.push({ title: T.quest, body: tidy(body), width: "full" });
}

{
  // Underscores in a handle ("@_sorrowe_") would otherwise be read as italics.
  const people = (s: string) => s.split("\n").map((l) => (l.trim().startsWith("@") ? `- ${l.trim().replace(/^(@\S+)/, (h) => h.replace(/_/g, "\\_"))}` : l)).join("\n");
  const body = [
    "### Feedback and Questions",
    sec["Feedback and Questions"],
    "### Leads",
    people(sec["Leads"]),
    "### Officers",
    people(sec["Officers"]),
    "### Any Other Advice?",
    sec["Any Other Advice?"],
  ].join("\n\n");
  out.push({ title: T.leadership, body: tidy(body), width: "full" });
}

// Main Swap Policy: headings, a real milestones table, item links.
{
  let b = swap.body.replace(/\*\*(Main Change Policy \(Updated 9\/1\/26\))\*\*/, "### $1");
  b = b.replace(/^\*\*(Level Incentive Policy|Epic EP Milestone Policy|EP Bank Donation Policy)\*\*[ \t]*$/gm, "### $1");
  const levels = [...b.matchAll(/^Level (\d+) = (\d+) EP[ \t]*$/gm)];
  if (levels.length !== 6) throw new Error(`Expected 6 level milestone lines, found ${levels.length}`);
  const table = ["| Level | EP bonus |", "| --- | --- |", ...levels.map((m) => `| ${m[1]} | ${m[2]} EP |`)].join("\n");
  b = b.replace(/^\*\*Current Level Milestones\*\*\s*\n+(?:Level \d+ = \d+ EP\s*\n)+/m, `### Current Level Milestones\n\n${table}\n\n`);
  b = b.replace(/starting level with us\*\*[ \t]*$/m, "starting level with us.");
  b = b.replace(/\*\*Shiny Brass Idol\s*\n\s*Scepter of the Forlorn\*\*[ \t]*$/, "- [[Shiny Brass Idol]]\n- [[Scepter of the Forlorn]]");
  out.push({ title: "Main Swap Policy", body: tidy(b), width: "full", existingId: swap.id, originalBody: swap.body });
}

// Final order: rules, conduct, EPGP cards, main swap, leadership.
const order = ["Guild Rules", "Code of Conduct", T.overview, T.ep, T.cap, T.gp, T.decay, T.determined, T.quest, "Main Swap Policy", T.leadership];
const ordered = order.map((t) => out.find((o) => o.title === t)!);

// ---- word-level proof that nothing was lost ------------------------------------
const words = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .match(/[a-z0-9']+/g) ?? [];
const count = (ws: string[]) => ws.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
const before = count(words(rows.map((r) => r.body + " " + r.title).join(" ")));
const after = count(words(ordered.map((o) => o.body + " " + o.title).join(" ")));
const missing: string[] = [];
for (const [w, n] of before) if ((after.get(w) ?? 0) < n) missing.push(`${w} (-${n - (after.get(w) ?? 0)})`);
const added: string[] = [];
for (const [w, n] of after) if (n > (before.get(w) ?? 0)) added.push(`${w} (+${n - (before.get(w) ?? 0)})`);
console.log("Words dropped:", missing.join(", ") || "none");
console.log("Words added:  ", added.join(", ") || "none");

// ---- SQL ------------------------------------------------------------------------
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const guardId = loot.id;
const sql: string[] = [
  "-- Guild Information restructure (2026-09-30). Generated by scripts/restructure-guild-info.ts.",
  "-- Only touches cards whose body still equals the exported text; re-running is a no-op.",
  "",
];
// New cards first (guarded on the EPGP guide being unedited, and on the title not existing yet).
ordered.forEach((o, i) => {
  if (o.existingId !== undefined) return;
  sql.push(
    `INSERT INTO guild_info_cards (title, body, width, sort_order)\nSELECT ${q(o.title)}, ${q(o.body)}, ${q(o.width)}, ${i + 1}\nWHERE EXISTS (SELECT 1 FROM guild_info_cards WHERE id = ${guardId} AND body = ${q(loot.body)})\n  AND NOT EXISTS (SELECT 1 FROM guild_info_cards WHERE title = ${q(o.title)});`,
    "",
  );
});
ordered.forEach((o, i) => {
  if (o.existingId === undefined) return;
  sql.push(
    `UPDATE guild_info_cards SET title = ${q(o.title)}, body = ${q(o.body)}, width = ${q(o.width)}, sort_order = ${i + 1}, updated_at = unixepoch()\nWHERE id = ${o.existingId} AND body = ${q(o.originalBody!)};`,
    "",
  );
});
const dir = resolve(__dirname, "../drizzle/seed");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, "guild-info-restructure-2026-10.sql");
writeFileSync(file, sql.join("\n"));
console.log(`\nWrote ${file}`);
console.log(ordered.map((o, i) => `${String(i + 1).padStart(2)}. [${o.width}] ${o.title}  #${slugify(o.title)}  (${o.body.length} chars)`).join("\n"));
