// Verifies the Zeal spellbook parser port (src/lib/spells/zeal-spellbook.ts)
// against the formats pq-companion's reader_test.go covers, plus the class
// matching the Spells tab import uses and the generated 61-65 dataset.
// Pure (no DB). Usage: npx tsx scripts/verify-spellbook.ts
import { getSpellByName, matchSpellbook, parseZealSpellbook, SPELL_CLASS_IDS, SPELLS, spellsForClass } from "../src/lib/spells";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}
const ids = (text: string) => [...parseZealSpellbook(text).spellIds];

check("id only", JSON.stringify(ids("1200\n2100\n3050\n")) === "[1200,2100,3050]");
check("slot\\tid", JSON.stringify(ids("1\t1200\n2\t2100\n3\t3050\n")) === "[1200,2100,3050]");
check("dedupe", ids("1200\n1200\n2100\n").length === 2);
check("id\\tname", JSON.stringify(ids("1200\tFoo Bar\n")) === "[1200]");

const modern = parseZealSpellbook(
  "Index\tSpellId\tLevel\tName\r\n26\t1359\t8\tEnchant Clay\r\n27\t667\t8\tEnchant Silver\r\n\r\n57\t668\t16\tEnchant Electrum\r\n",
);
check("modern ids (header skipped)", JSON.stringify([...modern.spellIds]) === "[1359,667,668]", JSON.stringify([...modern.spellIds]));
check("modern names lowercased", modern.names.has("enchant clay") && modern.names.size === 3);
check("modern line count", modern.lineCount === 3, String(modern.lineCount));

// Class matching: one spell by id, one by name with a drifted id.
const clr = spellsForClass(1);
const faith = getSpellByName("Faith")!;
const yaulp = getSpellByName("Yaulp VI")!;
const book = parseZealSpellbook(
  `Index\tSpellId\tLevel\tName\n1\t${faith.spellId}\t61\tFaith\n2\t999999\t65\tYaulp VI\n3\t202\t1\tCourage\n`,
);
const matched = matchSpellbook(book, clr).map((s) => s.spellId);
check("match by id", matched.includes(faith.spellId));
check("match by name fallback", matched.includes(yaulp.spellId));
check("non-tracked spell ignored", matched.length === 2, JSON.stringify(matched));

// Dataset sanity.
check("dataset non-empty", SPELLS.length > 200, String(SPELLS.length));
check("no WAR/MNK/ROG spells", !SPELL_CLASS_IDS.includes(0) && !SPELL_CLASS_IDS.includes(6) && !SPELL_CLASS_IDS.includes(8));
check("CLR has 27", clr.length === 27, String(clr.length));
check("class list sorted by level", clr.every((s, i) => i === 0 || clr[i - 1].level <= s.level));
check("shared spell keeps per-class level", spellsForClass(13).find((s) => s.name === "Pacification")?.level === 62);
check("levels in range", SPELLS.every((s) => s.classes.every((c) => c.level >= 61 && c.level <= 65)));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
