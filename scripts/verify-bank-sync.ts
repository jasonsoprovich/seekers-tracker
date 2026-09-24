// PLAN.md §9/§11 Phase 8.4 — guild bank sync end-to-end verification.
//
// Exercises src/lib/bank/sync.ts's real functions (loadBankConfig,
// setDesignations, saveEqAccount, deleteEqAccount, validateSyncPayload,
// previewSync, applySync) against local D1, same pattern as
// verify-guild-removal.ts: synthetic users/characters/holdings, snapshotted
// first and restored in a `finally` regardless of outcome. Never point this
// at remote D1 (PLAN.md §5).
//
// Usage:
//   npx tsx scripts/verify-bank-sync.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bankHoldings, characters, users } from "../src/db";
import {
  applySync,
  deleteEqAccount,
  loadBankConfig,
  previewSync,
  saveEqAccount,
  setDesignations,
  validateSyncPayload,
  type SyncHolderInput,
} from "../src/lib/bank/sync";
import { UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

const SNAPSHOT_NAME = "bank-sync-verify-test";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function check(failures: { n: number }, cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures.n++;
  }
}

async function makeCharacter(db: Db, name: string, opts: { charType?: "main" | "alt" | "mule" } = {}) {
  const [row] = await db
    .insert(characters)
    .values({ name, class: UNKNOWN_CLASS_ID, race: UNKNOWN_RACE_ID, level: 1, charType: opts.charType ?? "mule" })
    .returning({ id: characters.id });
  return row.id;
}

async function holdingsFor(db: Db, characterId: number) {
  return db
    .select({ container: bankHoldings.container, slotIndex: bankHoldings.slotIndex, itemName: bankHoldings.itemName, category: bankHoldings.category, status: bankHoldings.status, note: bankHoldings.note, source: bankHoldings.source })
    .from(bankHoldings)
    .where(eq(bankHoldings.holderCharacterId, characterId));
}

async function main() {
  console.log(`Saving snapshot '${SNAPSHOT_NAME}' before running a destructive test...`);
  execFileSync("scripts/snapshot.sh", ["save", SNAPSHOT_NAME], { stdio: "inherit" });

  const failures = { n: 0 };
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });

  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const [actor] = await db.select({ id: users.id }).from(users).limit(1);
    if (!actor) {
      console.error("No user in local D1 — seed the database first.");
      process.exit(1);
    }

    const muleId = await makeCharacter(db, `VerifyMule-${randomUUID().slice(0, 8)}`);
    const soloId = await makeCharacter(db, `VerifySolo-${randomUUID().slice(0, 8)}`);
    const altId = await makeCharacter(db, `VerifyAlt-${randomUUID().slice(0, 8)}`, { charType: "alt" });

    // ---------------------------------------------------------------
    // Scenario 1: designations round-trip and EQ account grouping.
    // ---------------------------------------------------------------
    console.log("\nScenario 1: designations + EQ account group");
    let result = await setDesignations(db, actor.id, { characterId: muleId }, ["Bank1", "Bank2"]);
    check(failures, !result.error, `setDesignations accepts personal containers (${result.error ?? "ok"})`);
    result = await setDesignations(db, actor.id, { characterId: muleId }, ["SharedBank2"]);
    check(failures, !!result.error, "setDesignations refuses a SharedBank container on a personal owner");

    const accountResult = await saveEqAccount(db, actor.id, {
      label: "Verify Account",
      characterIds: [muleId, altId],
      sharedBankHolderCharacterId: muleId,
    });
    check(failures, !accountResult.error && accountResult.id !== undefined, `saveEqAccount creates a group (${accountResult.error ?? "ok"})`);
    const accountId = accountResult.id!;

    const badHolder = await saveEqAccount(db, actor.id, { label: "Bad", characterIds: [muleId], sharedBankHolderCharacterId: soloId });
    check(failures, !!badHolder.error, "saveEqAccount refuses a holder that isn't a member of its own group");

    result = await setDesignations(db, actor.id, { eqAccountId: accountId }, ["SharedBank1", "SharedBank2"]);
    check(failures, !result.error, `setDesignations accepts SharedBank containers on an account owner (${result.error ?? "ok"})`);

    let config = await loadBankConfig(db);
    check(failures, (config.personalDesignations.get(muleId) ?? []).sort().join(",") === "Bank1,Bank2", "loadBankConfig reflects personal designations");
    check(failures, (config.sharedDesignations.get(accountId) ?? []).sort().join(",") === "SharedBank1,SharedBank2", "loadBankConfig reflects shared designations");
    check(failures, config.accountByCharacterId.get(altId)?.id === accountId, "loadBankConfig maps a member character back to its account");

    // ---------------------------------------------------------------
    // Scenario 2: validateSyncPayload rejects undesignated/wrong-holder rows.
    // ---------------------------------------------------------------
    console.log("\nScenario 2: server-side payload validation");
    const undesignatedRow: SyncHolderInput = {
      characterId: muleId,
      sourceFile: "Test-Inventory.txt",
      reportsSharedBank: false,
      rows: [{ container: "Bank5", slotIndex: 0, category: "item", itemName: "Undesignated Item", itemId: 999, quantity: 1 }],
    };
    let errors = validateSyncPayload([undesignatedRow], config);
    check(failures, errors.length === 1, "validateSyncPayload rejects a row in an undesignated container");

    const wrongHolderShared: SyncHolderInput = {
      characterId: altId, // altId is in the account but is NOT its SharedBank holder
      sourceFile: "Alt-Inventory.txt",
      reportsSharedBank: true,
      rows: [{ container: "SharedBank1", slotIndex: 1, category: "item", itemName: "Shared Item", itemId: 111, quantity: 1 }],
    };
    errors = validateSyncPayload([wrongHolderShared], config);
    check(failures, errors.length === 1, "validateSyncPayload rejects SharedBank rows from a non-holder character");

    const validPayload: SyncHolderInput = {
      characterId: muleId,
      sourceFile: "VerifyMule-Inventory.txt",
      reportsSharedBank: true,
      rows: [
        { container: "Bank1", slotIndex: 0, category: "item", itemName: "Test Ore", itemId: 300, quantity: 10 },
        { container: "Bank1", slotIndex: 1, category: "item", itemName: "Test Potion", itemId: 301, quantity: 5 },
        { container: "SharedBank1", slotIndex: 1, category: "item", itemName: "Shared Item A", itemId: 401, quantity: 2 },
      ],
    };
    errors = validateSyncPayload([validPayload], config);
    check(failures, errors.length === 0, "validateSyncPayload accepts a fully-designated payload");

    // ---------------------------------------------------------------
    // Scenario 3: dry-run writes nothing.
    // ---------------------------------------------------------------
    console.log("\nScenario 3: dry-run preview writes nothing");
    const beforeDryRun = await holdingsFor(db, muleId);
    check(failures, beforeDryRun.length === 0, "no holdings exist yet for the mule");
    const preview = await previewSync(db, [validPayload]);
    check(failures, preview.diffs[0]?.added.length === 3, `preview shows 3 added rows (got ${preview.diffs[0]?.added.length})`);
    const afterDryRun = await holdingsFor(db, muleId);
    check(failures, afterDryRun.length === 0, "dry-run wrote nothing to bank_holdings");

    // ---------------------------------------------------------------
    // Scenario 4: a real sync writes rows, leaves manual/currency rows
    // alone, and re-syncing is idempotent.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: real sync + manual/currency rows preserved + idempotent re-sync");
    await db.insert(bankHoldings).values([
      { holderCharacterId: muleId, category: "item", container: "Manual", slotIndex: 1, itemName: "Hand-added item", quantity: 1, status: "guild_bank", source: "manual" },
      { holderCharacterId: muleId, category: "currency", container: "Bank-Coin", slotIndex: 0, itemName: "Currency", quantity: 5000, status: "guild_bank", source: "import" },
      // Simulates a leftover row from the old spreadsheet import (source=import, no import_id) at the SAME slot the real sync will also write — proves it gets replaced, not duplicated.
      { holderCharacterId: muleId, category: "item", container: "Bank1", slotIndex: 0, itemName: "Stale Sheet Item", quantity: 1, status: "reserved", note: "from the old sheet", source: "import" },
    ]);

    const applied1 = await applySync(db, actor.id, [validPayload]);
    check(failures, applied1.diffs[0]?.added.length === 2, `first sync adds the 2 new rows not already present (got ${applied1.diffs[0]?.added.length})`);

    const afterSync1 = await holdingsFor(db, muleId);
    check(failures, afterSync1.length === 5, `5 rows exist after sync: 3 imported (the stale sheet row was replaced, not added alongside) + 1 manual + 1 currency (untouched) (got ${afterSync1.length})`);
    const manualRow = afterSync1.find((r) => r.source === "manual");
    check(failures, manualRow?.itemName === "Hand-added item", "the manual row survived the sync untouched");
    const currencyRow = afterSync1.find((r) => r.category === "currency");
    check(failures, currencyRow?.itemName === "Currency", "the currency row survived the sync untouched");
    const bank1Slot0 = afterSync1.find((r) => r.container === "Bank1" && r.slotIndex === 0);
    check(failures, bank1Slot0?.itemName === "Test Ore", "the stale sheet row at Bank1 slot 0 was replaced by the real synced item");

    // Re-sync the identical payload: idempotent, no changes.
    const applied2 = await applySync(db, actor.id, [validPayload]);
    check(
      failures,
      applied2.diffs[0]?.added.length === 0 && applied2.diffs[0]?.removed.length === 0 && applied2.diffs[0]?.changed.length === 0,
      `re-syncing the identical payload is a no-op (added=${applied2.diffs[0]?.added.length} removed=${applied2.diffs[0]?.removed.length} changed=${applied2.diffs[0]?.changed.length})`,
    );
    const afterSync2 = await holdingsFor(db, muleId);
    check(failures, afterSync2.length === 5, "row count unchanged after an idempotent re-sync");

    // ---------------------------------------------------------------
    // Scenario 5: status/note carry over on a matching (container, slot).
    // ---------------------------------------------------------------
    console.log("\nScenario 5: status/note carry over across a re-sync");
    await db
      .update(bankHoldings)
      .set({ status: "reserved", note: "officer's own stash, not guild's" })
      .where(and(eq(bankHoldings.holderCharacterId, muleId), eq(bankHoldings.container, "Bank1"), eq(bankHoldings.slotIndex, 1)));
    const applied3 = await applySync(db, actor.id, [validPayload]);
    check(failures, applied3.diffs[0]?.unchanged === 3, "re-sync sees the annotated row as unchanged (item identity/qty didn't change)");
    const afterAnnotate = await holdingsFor(db, muleId);
    const annotatedRow = afterAnnotate.find((r) => r.container === "Bank1" && r.slotIndex === 1);
    check(failures, annotatedRow?.status === "reserved" && annotatedRow?.note === "officer's own stash, not guild's", "status/note survived the re-sync");

    // ---------------------------------------------------------------
    // Scenario 6: clearing all designations and re-syncing empties the
    // holder (except manual/currency rows).
    // ---------------------------------------------------------------
    console.log("\nScenario 6: clearing designations empties the holder on next sync");
    const emptyPayload: SyncHolderInput = { characterId: muleId, sourceFile: "VerifyMule-Inventory.txt", reportsSharedBank: true, rows: [] };
    const applied4 = await applySync(db, actor.id, [emptyPayload]);
    check(failures, applied4.diffs[0]?.removed.length === 3, `clearing to zero rows removes all 3 previously-synced rows (got ${applied4.diffs[0]?.removed.length})`);
    const afterClear = await holdingsFor(db, muleId);
    check(failures, afterClear.length === 2, `only the manual + currency rows remain (got ${afterClear.length})`);
    check(failures, afterClear.every((r) => r.source === "manual" || r.category === "currency"), "every remaining row is manual or currency");

    // ---------------------------------------------------------------
    // Scenario 7: deleteEqAccount cleans up its designations/membership.
    // ---------------------------------------------------------------
    console.log("\nScenario 7: deleteEqAccount cleanup");
    const deleteResult = await deleteEqAccount(db, accountId);
    check(failures, !deleteResult.error, `deleteEqAccount succeeds (${deleteResult.error ?? "ok"})`);
    config = await loadBankConfig(db);
    check(failures, config.accounts.every((a) => a.id !== accountId), "the deleted account no longer appears in loadBankConfig");
    check(failures, (config.sharedDesignations.get(accountId) ?? []).length === 0, "the deleted account's shared designations are gone");

    // A payload that used to be valid via the (now-deleted) account is
    // rejected again — proves validation reads live config, not a cache.
    // muleId is no longer in any account, so it fails the holder-level
    // "designated SharedBank holder" check before ever reaching a
    // per-container check.
    errors = validateSyncPayload([validPayload], config);
    check(failures, errors.length === 1 && /designated SharedBank holder/i.test(errors[0].error), "SharedBank rows are rejected again once the account is gone");

    const remainingCharacterIds = await db
      .select({ id: characters.id })
      .from(characters)
      .where(inArray(characters.id, [muleId, soloId, altId]));
    check(failures, remainingCharacterIds.length === 3, "deleting the account did not delete its member characters");

    if (failures.n > 0) {
      console.error(`\n${failures.n} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll checks passed.");
    }
  } finally {
    await proxy.dispose();
    console.log(`Restoring snapshot '${SNAPSHOT_NAME}'...`);
    execFileSync("scripts/snapshot.sh", ["restore", SNAPSHOT_NAME], { stdio: "inherit" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
