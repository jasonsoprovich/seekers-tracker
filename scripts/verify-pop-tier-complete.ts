// Verifies the tier "complete" display rule in src/lib/pop-flags/resolve.ts:
// a tier reads complete only when its done/total tally is full AND no
// key-ring step (role "keyring") is pending. "key" and "optional" rows never
// hold a tier open, and key-rings never touch the tally.
// Pure (no DB). Usage: npx tsx scripts/verify-pop-tier-complete.ts
import { getFlags, keyringsLeftNote, resolveFlags, tierComplete, type FlagState } from "../src/lib/pop-flags";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

// Every counted (non-optional, non-group) flag up to and including Tier 3
// done; no optional rows done.
const counted = getFlags().filter((f) => f.tier <= 3 && !f.optional && !f.group);
const base: FlagState[] = counted.map((f) => ({ flagId: f.id, done: true, source: "manual" }));
const done = (id: string): FlagState => ({ flagId: id, done: true, source: "manual" });

function tier3(states: FlagState[]) {
  const r = resolveFlags(states);
  return r.tiers.find((t) => t.tier === 3)!;
}

// Full tally + pending key-ring (solro_pofire_keyring) + pending key
// (bot_torden_key) -> not complete, note names the key-ring.
const pending = tier3(base);
check("tally full with key-ring pending", pending.done === pending.total && pending.total > 0, `${pending.done}/${pending.total}`);
check("key-ring pending -> not complete", !tierComplete(pending));
check(
  "pending list is only the key-ring",
  JSON.stringify(pending.pendingKeyrings) === JSON.stringify(["Jump into the floor door (Plane of Fire key-ring)"]),
  JSON.stringify(pending.pendingKeyrings),
);
check(
  "note names the key-ring",
  keyringsLeftNote(pending) === "Key-ring left: Jump into the floor door (Plane of Fire key-ring)",
  String(keyringsLeftNote(pending)),
);

// Full tally + key-ring done -> complete (the pending "key" row doesn't block).
const withKeyring = tier3([...base, done("solro_pofire_keyring")]);
check("key-ring doesn't change the tally", withKeyring.done === pending.done && withKeyring.total === pending.total);
check("key-ring done, key pending -> complete", tierComplete(withKeyring));
check("no note once key-ring done", keyringsLeftNote(withKeyring) === null);

// Tier 1/2 key-rings: pending key-ring holds them open; their "key" and
// "optional" rows never do.
const all = resolveFlags([...base, done("pod_cod_keyring"), done("pov_hoh_keyring")]);
for (const t of all.tiers.filter((t) => (t.tier ?? 0) <= 2)) {
  check(`tier ${t.tier} key-ring done, key/optional pending -> complete`, tierComplete(t), JSON.stringify(t));
}
const t1Open = resolveFlags(base).tiers.find((t) => t.tier === 1)!;
check("tier 1 pit key-ring pending -> not complete", !tierComplete(t1Open));

// Not-yet-full tally: never complete, and no key-ring note (the tally
// already says there's work left).
const partial = tier3(base.filter((s) => s.flagId !== "solro_solusek"));
check("partial tally -> not complete", !tierComplete(partial));
check("partial tally -> no key-ring note", keyringsLeftNote(partial) === null);

// Multiple pending key-rings -> counted note.
check(
  "multiple key-rings note",
  keyringsLeftNote({ done: 1, total: 1, pendingKeyrings: ["A", "B"] }) === "2 key-rings left: A; B",
);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
