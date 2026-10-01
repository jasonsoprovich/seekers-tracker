// Verifies the Guild Information Markdown normalizer against the shapes of
// real Discord pastes (tab-indented "•" bullets, loose bold, spacer runs).
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Markdown from "markdown-to-jsx/react";

import { normalizeGuildMarkdown, slugify, splitSpacers } from "../src/lib/guild-info-markdown";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n${detail}` : ""}`);
  if (!ok) failed++;
}
const render = (md: string) =>
  splitSpacers(normalizeGuildMarkdown(md))
    .map((c) => renderToStaticMarkup(createElement(Markdown, { options: { disableParsingRawHTML: true } }, c)))
    .join("<!--gap-->");

const discord = [
  "Examples on how a tagged member can earn EP:",
  "",
  "\t• **Raiding**",
  "\t\t• Raiding attendance requires your MAIN character.",
  "\t\t• There will be times where a class is needed. **If the Event Lead asks you** to play an alt.",
  "",
  "\t• **Guild Bank Donation**",
  "\t\t• The guild collects specific items.",
  "",
  "•** Player Quests**",
  "\t\t• Player Quests are member run events.",
].join("\n");

const html = render(discord);
check("no <pre>/<code> from indented bullets", !/<pre|<code/.test(html), html);
check("bullets become list items", (html.match(/<li/g) ?? []).length >= 6, html);
check("nested list present", /<ul[^>]*>.*<ul/s.test(html), html);
check("no literal ** left", !html.includes("**"), html);
check("loose bold fixed", html.includes("<strong>Player Quests</strong>"), html);

const spacers = render("one\n\n\n\ntwo");
check("extra blank lines become spacers", spacers.split("<!--gap-->").length === 3, spacers);

const fenced = normalizeGuildMarkdown("```\n    keep   me\n\t• raw\n```");
check("fenced blocks untouched", fenced === "```\n    keep   me\n\t• raw\n```", fenced);

const discordBreaks = render("line a\nline b");
check("single newline is a line break", /<br/.test(discordBreaks), discordBreaks);

const numbered = render("1. First\n2. Second\n3. Third");
check("numbered list stays an ordered list", /<ol/.test(numbered) && (numbered.match(/<li/g) ?? []).length === 3, numbered);

const item = render("Grab the [[Short Sword of the Ykesha]] now");
check("[[item]] becomes an #item= link", item.includes("#item=Short%20Sword%20of%20the%20Ykesha"), item);

check("slugify", slugify("EP/GP Decay & Caps") === "ep-gp-decay-and-caps");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
