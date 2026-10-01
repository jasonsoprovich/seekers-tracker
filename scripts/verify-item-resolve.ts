// Verifies item-name normalization (parity with the officer app's Go
// normalize) and name -> PQDI id resolution against the seeded local `items`
// table. Read-only. Run `npm run import:items` first on a fresh DB.
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { normalizeItemName } from "../src/lib/items/normalize";
import { resolveItemNames } from "../src/lib/items/resolve";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failed++;
}

async function main() {
  // normalize parity with items.go
  check("lowercases + collapses whitespace", normalizeItemName("  Short   Sword  of the Ykesha ") === "short sword of the ykesha");
  check("backtick -> apostrophe", normalizeItemName("Song: Denon`s Dissension") === "song: denon's dissension");
  check("curly quotes -> apostrophe", normalizeItemName("Denon’s Drums of Declivity") === "denon's drums of declivity");

  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });
    const names = ["Short Sword of the Ykesha", "engraved ring", "Denon`s Drums of Declivity", "Not A Real Quarm Item"];
    const ids = await resolveItemNames(db, names);
    check("5500 = Short Sword of the Ykesha (matches PQDI)", ids["Short Sword of the Ykesha"] === 5500, ids);
    check("1681 = Engraved Ring, case-insensitive", ids["engraved ring"] === 1681, ids);
    check("Denon's Drums of Declivity = 28149 (officer-app test id), via backtick spelling", ids["Denon`s Drums of Declivity"] === 28149, ids);
    check("unknown name -> null", ids["Not A Real Quarm Item"] === null, ids);

    // more than one IN-list chunk (D1's 100-param cap)
    const many = Array.from({ length: 180 }, (_, i) => `Nonexistent item ${i}`);
    const out = await resolveItemNames(db, [...many, "Short Sword of the Ykesha"]);
    check("180+ names resolve across chunks", out["Short Sword of the Ykesha"] === 5500 && Object.keys(out).length === 181, Object.keys(out).length);
  } finally {
    await proxy.dispose();
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}
void main();
