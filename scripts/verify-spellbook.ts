// Verifies the Zeal spellbook parser port (src/lib/spells/zeal-spellbook.ts)
// against the formats pq-companion's reader_test.go covers, plus the class
// matching the Spells tab import uses and the generated 61-65 dataset.
// Pure (no DB). Usage: npx tsx scripts/verify-spellbook.ts
import { getSpellByName, isClassSpell, matchSpellbook, parseZealSpellbook, SPELL_CLASS_IDS, SPELLS, spellsForClass } from "../src/lib/spells";
import { allSpellsForClass, lowSpellsForClass } from "../src/lib/spells/all";

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

// Level 1-60 list ("All spells" view) and the 1-65 import match.
const clrLow = lowSpellsForClass(1);
check("CLR has 1-60 spells", clrLow.length > 150, String(clrLow.length));
check("1-60 levels in range", clrLow.every((s) => s.level >= 1 && s.level <= 60));
check("1-60 sorted by level", clrLow.every((s, i) => i === 0 || clrLow[i - 1].level <= s.level));
const clrAll = allSpellsForClass(1);
check("all = 1-60 + 61-65", clrAll.length === clrLow.length + clr.length);
check("no spell twice for a class", new Set(clrAll.map((s) => s.spellId)).size === clrAll.length);
const allMatched = matchSpellbook(book, clrAll).map((s) => s.spellId);
check("import matches 1-60 too", allMatched.includes(202) && allMatched.length === 3, JSON.stringify(allMatched));
check("CLR 1-60 rows never pass the /spells class filter", clrLow.every((s) => !isClassSpell(1, s.spellId)));
check("cross-class overlap: Annul Magic is ENC 61-65 but CLR 1-60", isClassSpell(14, 1526) && !isClassSpell(1, 1526) && clrLow.some((s) => s.spellId === 1526));
for (const c of SPELL_CLASS_IDS) {
  const ids = allSpellsForClass(c).map((s) => s.spellId);
  if (new Set(ids).size !== ids.length) check(`class ${c} no duplicates`, false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
