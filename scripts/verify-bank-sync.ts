// PLAN.md §9/§11 Phase 8.4 — guild bank sync end-to-end verification.
// Extended 2026-09-25 for the officer-feedback pass: per-item (sub-slot)
// designation, add/remove without clobbering other flags, occupant-driven
// expected_* refresh, the currency purge, and retireSheetRows.
//
// Exercises src/lib/bank/sync.ts's real functions (loadBankConfig,
// updateDesignations, saveEqAccount, deleteEqAccount, validateSyncPayload,
// previewSync, applySync, retireSheetRows) against local D1, same pattern
// as verify-guild-removal.ts: synthetic users/characters/holdings,
// snapshotted first and restored in a `finally` regardless of outcome.
// Never point this at remote D1 (PLAN.md §5).
//
// Usage:
//   npx tsx scripts/verify-bank-sync.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { bankAuditLog, bankHoldings, characters, users } from "../src/db";
import { createManualHolding, deleteManualHolding, updateHolding } from "../src/lib/bank/holdings";
import {
  applySync,
  deleteEqAccount,
  loadBankConfig,
  previewSync,
  retireSheetRows,
  saveEqAccount,
  updateDesignations,
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
    .select({ container: bankHoldings.container, slotIndex: bankHoldings.slotIndex, itemName: bankHoldings.itemName, category: bankHoldings.category, status: bankHoldings.status, note: bankHoldings.note, source: bankHoldings.source, importId: bankHoldings.importId })
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
    let result = await updateDesignations(db, actor.id, { characterId: muleId }, { set: [{ container: "Bank1", slotIndex: 0 }, { container: "Bank2", slotIndex: 0 }] });
    check(failures, !result.error, `updateDesignations accepts personal containers (${result.error ?? "ok"})`);
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { set: [{ container: "SharedBank2", slotIndex: 0 }] });
    check(failures, !!result.error, "updateDesignations refuses a SharedBank container on a personal owner");

    const accountResult = await saveEqAccount(db, actor.id, {
      label: "Verify Account",
      characterIds: [muleId, altId],
      sharedBankHolderCharacterId: muleId,
    });
    check(failures, !accountResult.error && accountResult.id !== undefined, `saveEqAccount creates a group (${accountResult.error ?? "ok"})`);
    const accountId = accountResult.id!;

    const badHolder = await saveEqAccount(db, actor.id, { label: "Bad", characterIds: [muleId], sharedBankHolderCharacterId: soloId });
    check(failures, !!badHolder.error, "saveEqAccount refuses a holder that isn't a member of its own group");

    result = await updateDesignations(db, actor.id, { eqAccountId: accountId }, { set: [{ container: "SharedBank1", slotIndex: 0 }, { container: "SharedBank2", slotIndex: 0 }] });
    check(failures, !result.error, `updateDesignations accepts SharedBank containers on an account owner (${result.error ?? "ok"})`);

    // Regression: "Mark all Bank slots guild" sends all 30 real Bank
    // containers in one call (Darkclaw-Inventory.txt has all 30 real —
    // found via a real click-through 2026-09-24). Each row binds several
    // params; an unchunked insert (30 rows) blows past D1's 100-param
    // cap and 500s.
    const allBankContainers = Array.from({ length: 30 }, (_, i) => ({ container: `Bank${i + 1}`, slotIndex: 0 }));
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { set: allBankContainers });
    check(failures, !result.error, `updateDesignations accepts all 30 real Bank containers in one call, unchunked (${result.error ?? "ok"})`);
    let config = await loadBankConfig(db);
    check(
      failures,
      (config.personalDesignations.get(muleId) ?? []).length === 30,
      `all 30 Bank containers landed (got ${(config.personalDesignations.get(muleId) ?? []).length})`,
    );
    // Reset back to the smaller set the rest of this script's scenarios expect.
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { set: [{ container: "Bank1", slotIndex: 0 }, { container: "Bank2", slotIndex: 0 }] });
    check(failures, !result.error, `updateDesignations resets back to Bank1/Bank2 (${result.error ?? "ok"})`);

    config = await loadBankConfig(db);
    check(
      failures,
      (config.personalDesignations.get(muleId) ?? []).map((s) => s.container).sort().join(",") === "Bank1,Bank2",
      "loadBankConfig reflects personal designations",
    );
    check(
      failures,
      (config.sharedDesignations.get(accountId) ?? []).map((s) => s.container).sort().join(",") === "SharedBank1,SharedBank2",
      "loadBankConfig reflects shared designations",
    );
    check(failures, config.accountByCharacterId.get(altId)?.id === accountId, "loadBankConfig maps a member character back to its account");

    // ---------------------------------------------------------------
    // Scenario 1b: per-item (sub-slot) designation, and add/remove leave
    // OTHER flags untouched — the real bug found 2026-09-24: the old
    // toggle always PUT the whole rebuilt set, so a flag on a container
    // missing from the current export (e.g. its bag moved away) silently
    // vanished on the next click.
    // ---------------------------------------------------------------
    console.log("\nScenario 1b: sub-slot designation + add/remove don't clobber other flags");
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { add: [{ container: "Bank3", slotIndex: 2, expectedItemId: 500, expectedItemName: "Sub-slot Item" }] });
    check(failures, !result.error, `add accepts a sub-slot position (${result.error ?? "ok"})`);
    config = await loadBankConfig(db);
    const bank3Slots = config.personalDesignations.get(muleId) ?? [];
    check(failures, bank3Slots.some((s) => s.container === "Bank3" && s.slotIndex === 2), "the sub-slot designation landed");
    check(failures, bank3Slots.some((s) => s.container === "Bank1" && s.slotIndex === 0), "add left Bank1 (added earlier via set) untouched");
    check(failures, bank3Slots.some((s) => s.container === "Bank2" && s.slotIndex === 0), "add left Bank2 untouched");

    result = await updateDesignations(db, actor.id, { characterId: muleId }, { remove: [{ container: "Bank3", slotIndex: 2 }] });
    check(failures, !result.error, `remove accepts a sub-slot position (${result.error ?? "ok"})`);
    config = await loadBankConfig(db);
    const afterRemove = config.personalDesignations.get(muleId) ?? [];
    check(failures, !afterRemove.some((s) => s.container === "Bank3" && s.slotIndex === 2), "the sub-slot designation is gone after remove");
    check(failures, afterRemove.some((s) => s.container === "Bank1" && s.slotIndex === 0), "remove left Bank1 untouched");
    check(failures, afterRemove.length === 2, `exactly the original 2 designations remain (got ${afterRemove.length})`);

    // A designation that's missing from the current export (simulating a
    // moved/empty bag) must survive an add/remove call that never mentions
    // it — this is the actual regression, not just "did the API accept a
    // sub-slot", so add something else and confirm Bank1/Bank2 are still
    // there afterward.
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { add: [{ container: "Bank4", slotIndex: 0 }] });
    check(failures, !result.error, "add accepts another container");
    config = await loadBankConfig(db);
    const afterSecondAdd = (config.personalDesignations.get(muleId) ?? []).map((s) => s.container).sort();
    check(failures, afterSecondAdd.join(",") === "Bank1,Bank2,Bank4", `Bank1/Bank2 survived an unrelated add (got ${afterSecondAdd.join(",")})`);
    result = await updateDesignations(db, actor.id, { characterId: muleId }, { remove: [{ container: "Bank4", slotIndex: 0 }] });
    check(failures, !result.error, "remove cleans up Bank4");

    // ---------------------------------------------------------------
    // Scenario 2: validateSyncPayload rejects undesignated/wrong-holder rows,
    // and a slot-0 designation covers every sub-slot in that container.
    // ---------------------------------------------------------------
    console.log("\nScenario 2: server-side payload validation");
    config = await loadBankConfig(db);
    const undesignatedRow: SyncHolderInput = {
      characterId: muleId,
      sourceFile: "Test-Inventory.txt",
      reportsSharedBank: false,
      rows: [{ container: "Bank5", slotIndex: 0, category: "item", itemName: "Undesignated Item", itemId: 999, quantity: 1 }],
      occupants: [],
    };
    let errors = validateSyncPayload([undesignatedRow], config);
    check(failures, errors.length === 1, "validateSyncPayload rejects a row in an undesignated container");

    const wrongHolderShared: SyncHolderInput = {
      characterId: altId, // altId is in the account but is NOT its SharedBank holder
      sourceFile: "Alt-Inventory.txt",
      reportsSharedBank: true,
      rows: [{ container: "SharedBank1", slotIndex: 1, category: "item", itemName: "Shared Item", itemId: 111, quantity: 1 }],
      occupants: [],
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
      occupants: [{ container: "Bank1", slotIndex: 0, itemId: 300, itemName: "Test Ore" }],
    };
    errors = validateSyncPayload([validPayload], config);
    check(failures, errors.length === 0, "validateSyncPayload accepts a fully-designated payload (Bank1's slot-0 flag covers its sub-slots)");

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
    // Scenario 4: a real sync writes rows, leaves manual rows alone
    // (currency rows can no longer exist at all — migration 0050 purged
    // them and the manual-add form no longer offers the category), and
    // re-syncing is idempotent.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: real sync + manual rows preserved + idempotent re-sync");
    await db.insert(bankHoldings).values([
      { holderCharacterId: muleId, category: "item", container: "Manual", slotIndex: 1, itemName: "Hand-added item", quantity: 1, status: "guild_bank", source: "manual" },
      // Simulates a leftover row from the old spreadsheet import (source=import, import_id NULL) at the SAME slot the real sync will also write — proves it gets replaced, not duplicated.
      { holderCharacterId: muleId, category: "item", container: "Bank1", slotIndex: 0, itemName: "Stale Sheet Item", quantity: 1, status: "reserved", note: "from the old sheet", source: "import", importId: null },
    ]);

    let applied1 = await applySync(db, actor.id, [validPayload], config);
    check(failures, applied1.diffs[0]?.added.length === 2, `first sync adds the 2 new rows not already present (got ${applied1.diffs[0]?.added.length})`);

    const afterSync1 = await holdingsFor(db, muleId);
    check(failures, afterSync1.length === 4, `4 rows exist after sync: 3 imported (the stale sheet row was replaced, not added alongside) + 1 manual (got ${afterSync1.length})`);
    const manualRow = afterSync1.find((r) => r.source === "manual");
    check(failures, manualRow?.itemName === "Hand-added item", "the manual row survived the sync untouched");
    const bank1Slot0 = afterSync1.find((r) => r.container === "Bank1" && r.slotIndex === 0);
    check(failures, bank1Slot0?.itemName === "Test Ore", "the stale sheet row at Bank1 slot 0 was replaced by the real synced item");

    // The occupant sent in validPayload should have refreshed Bank1's
    // expected_item_id/expected_item_name.
    config = await loadBankConfig(db);
    const bank1Designation = (config.personalDesignations.get(muleId) ?? []).find((s) => s.container === "Bank1" && s.slotIndex === 0);
    check(failures, bank1Designation?.expectedItemId === 300 && bank1Designation?.expectedItemName === "Test Ore", "applySync refreshed the designation's expected occupant from the sync's occupants list");

    // Re-sync the identical payload: idempotent, no changes.
    const applied2 = await applySync(db, actor.id, [validPayload], config);
    check(
      failures,
      applied2.diffs[0]?.added.length === 0 && applied2.diffs[0]?.removed.length === 0 && applied2.diffs[0]?.changed.length === 0,
      `re-syncing the identical payload is a no-op (added=${applied2.diffs[0]?.added.length} removed=${applied2.diffs[0]?.removed.length} changed=${applied2.diffs[0]?.changed.length})`,
    );
    const afterSync2 = await holdingsFor(db, muleId);
    check(failures, afterSync2.length === 4, "row count unchanged after an idempotent re-sync");

    // ---------------------------------------------------------------
    // Scenario 5: status/note carry over on a matching (container, slot).
    // ---------------------------------------------------------------
    console.log("\nScenario 5: status/note carry over across a re-sync");
    await db
      .update(bankHoldings)
      .set({ status: "reserved", note: "officer's own stash, not guild's" })
      .where(and(eq(bankHoldings.holderCharacterId, muleId), eq(bankHoldings.container, "Bank1"), eq(bankHoldings.slotIndex, 1)));
    const applied3 = await applySync(db, actor.id, [validPayload], config);
    check(failures, applied3.diffs[0]?.unchanged === 3, "re-sync sees the annotated row as unchanged (item identity/qty didn't change)");
    const afterAnnotate = await holdingsFor(db, muleId);
    const annotatedRow = afterAnnotate.find((r) => r.container === "Bank1" && r.slotIndex === 1);
    check(failures, annotatedRow?.status === "reserved" && annotatedRow?.note === "officer's own stash, not guild's", "status/note survived the re-sync");

    // ---------------------------------------------------------------
    // Scenario 6: clearing all designations and re-syncing empties the
    // holder (except manual rows).
    // ---------------------------------------------------------------
    console.log("\nScenario 6: clearing designations empties the holder on next sync");
    const emptyPayload: SyncHolderInput = { characterId: muleId, sourceFile: "VerifyMule-Inventory.txt", reportsSharedBank: true, rows: [], occupants: [] };
    const applied4 = await applySync(db, actor.id, [emptyPayload], config);
    check(failures, applied4.diffs[0]?.removed.length === 3, `clearing to zero rows removes all 3 previously-synced rows (got ${applied4.diffs[0]?.removed.length})`);
    const afterClear = await holdingsFor(db, muleId);
    check(failures, afterClear.length === 1, `only the manual row remains (got ${afterClear.length})`);
    check(failures, afterClear.every((r) => r.source === "manual"), "every remaining row is manual");

    // ---------------------------------------------------------------
    // Scenario 6b: currency is purged and can never be listed.
    // ---------------------------------------------------------------
    console.log("\nScenario 6b: currency rows are gone and never re-appear");
    const currencyCheck = await db.select({ id: bankHoldings.id }).from(bankHoldings).where(eq(bankHoldings.category, "currency"));
    check(failures, currencyCheck.length === 0, "no currency rows exist anywhere after migration 0050's purge");

    // ---------------------------------------------------------------
    // Scenario 6c: retireSheetRows removes only source=import rows with a
    // NULL import_id, never a real synced row or a manual one.
    // ---------------------------------------------------------------
    console.log("\nScenario 6c: retireSheetRows");
    await db.insert(bankHoldings).values([
      { holderCharacterId: soloId, category: "item", container: "Bank1", slotIndex: 0, itemName: "Sheet-only item A", quantity: 1, status: "guild_bank", source: "import", importId: null },
      { holderCharacterId: soloId, category: "item", container: "Bank2", slotIndex: 0, itemName: "Sheet-only item B", quantity: 1, status: "guild_bank", source: "import", importId: null },
    ]);
    const soloBeforeRetire = await holdingsFor(db, soloId);
    check(failures, soloBeforeRetire.length === 2, "two sheet rows exist for the solo character before retiring");
    const retireOne = await retireSheetRows(db, soloId);
    check(failures, retireOne.removed === 2, `retireSheetRows(soloId) removed exactly its 2 sheet rows (got ${retireOne.removed})`);
    const soloAfterRetire = await holdingsFor(db, soloId);
    check(failures, soloAfterRetire.length === 0, "the solo character's holdings are empty after retiring");
    const muleAfterRetire = await holdingsFor(db, muleId);
    check(failures, muleAfterRetire.length === 1 && muleAfterRetire[0].source === "manual", "retiring a different holder's sheet rows left the mule's manual row alone");

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

    // ---------------------------------------------------------------
    // Scenario 8: item-level audit trail (bank_audit_log) — both the
    // sync path (applySync's buildSyncAuditRows) and the manual add/
    // edit/delete path (holdings.ts), which no other verify script
    // exercises at all.
    // ---------------------------------------------------------------
    console.log("\nScenario 8: item-level audit trail (bank_audit_log)");
    async function auditRowsFor(characterId: number) {
      return db.select().from(bankAuditLog).where(eq(bankAuditLog.holderCharacterId, characterId)).orderBy(bankAuditLog.id);
    }

    // Bank1 slot 0 is still a valid personal designation for muleId (set
    // in Scenario 1, reset after the 30-container regression check).
    const auditPayload: SyncHolderInput = {
      characterId: muleId,
      sourceFile: "VerifyMule-Inventory.txt",
      reportsSharedBank: false,
      rows: [{ container: "Bank1", slotIndex: 0, category: "item", itemName: "Audit Test Item", itemId: 999, quantity: 1 }],
      occupants: [],
    };
    config = await loadBankConfig(db);
    await applySync(db, actor.id, [auditPayload], config);
    let auditRows = await auditRowsFor(muleId);
    const createRow = auditRows.find((r) => r.action === "create" && r.itemName === "Audit Test Item");
    check(failures, !!createRow, "syncing a brand-new item writes a 'create' bank_audit_log row");
    check(failures, createRow?.source === "sync" && createRow?.before === null, "the create row is source='sync' with a null before");
    check(
      failures,
      (createRow?.after as { itemName?: string; quantity?: number } | null)?.itemName === "Audit Test Item" &&
        (createRow?.after as { quantity?: number } | null)?.quantity === 1,
      "the create row's after snapshot matches the synced item",
    );

    // Update: same slot, quantity changes 1 -> 5.
    config = await loadBankConfig(db);
    await applySync(db, actor.id, [{ ...auditPayload, rows: [{ ...auditPayload.rows[0], quantity: 5 }] }], config);
    auditRows = await auditRowsFor(muleId);
    const updateRow = auditRows.find((r) => r.action === "update" && r.itemName === "Audit Test Item");
    check(
      failures,
      (updateRow?.before as { quantity?: number } | null)?.quantity === 1 && (updateRow?.after as { quantity?: number } | null)?.quantity === 5,
      "a quantity change on the next sync writes an 'update' row with the correct before/after",
    );

    // Delete: the item drops out of the next sync entirely.
    config = await loadBankConfig(db);
    await applySync(db, actor.id, [{ ...auditPayload, rows: [] }], config);
    auditRows = await auditRowsFor(muleId);
    const deleteRow = auditRows.find((r) => r.action === "delete" && r.itemName === "Audit Test Item");
    check(
      failures,
      deleteRow?.source === "sync" && deleteRow?.after === null && (deleteRow?.before as { quantity?: number } | null)?.quantity === 5,
      "removing the item on the next sync writes a 'delete' row with the last-known (qty 5) snapshot",
    );

    // Manual add/edit/delete — the other write path into the same table.
    const [{ name: muleName }] = await db.select({ name: characters.name }).from(characters).where(eq(characters.id, muleId));
    const manualCreate = await createManualHolding(
      db,
      { holderName: muleName, category: "item", itemName: "Manual Audit Item", quantity: 2, status: "guild_bank" },
      actor.id,
    );
    check(failures, manualCreate.id !== undefined, `createManualHolding succeeds (${manualCreate.error ?? "ok"})`);
    let manualAuditRows = await auditRowsFor(muleId);
    const manualCreateRow = manualAuditRows.find((r) => r.action === "create" && r.itemName === "Manual Audit Item");
    check(failures, manualCreateRow?.source === "manual" && manualCreateRow?.holdingId === manualCreate.id, "a manual add writes a 'create' row with source='manual' and the real holding id");

    const manualUpdate = await updateHolding(db, manualCreate.id!, { status: "reserved", quantity: 3 }, actor.id);
    check(failures, !manualUpdate.error, `updateHolding succeeds (${manualUpdate.error ?? "ok"})`);
    manualAuditRows = await auditRowsFor(muleId);
    const manualUpdateRow = manualAuditRows.find((r) => r.action === "update" && r.itemName === "Manual Audit Item");
    check(
      failures,
      (manualUpdateRow?.before as { quantity?: number; status?: string } | null)?.quantity === 2 &&
        (manualUpdateRow?.after as { quantity?: number; status?: string } | null)?.quantity === 3 &&
        (manualUpdateRow?.after as { status?: string } | null)?.status === "reserved",
      "a manual edit writes an 'update' row with the real before/after (qty 2→3, status→reserved)",
    );

    const manualDelete = await deleteManualHolding(db, manualCreate.id!, actor.id);
    check(failures, !manualDelete.error, `deleteManualHolding succeeds (${manualDelete.error ?? "ok"})`);
    manualAuditRows = await auditRowsFor(muleId);
    const manualDeleteRow = manualAuditRows.find((r) => r.action === "delete" && r.itemName === "Manual Audit Item");
    check(
      failures,
      manualDeleteRow?.after === null && (manualDeleteRow?.before as { quantity?: number } | null)?.quantity === 3,
      "a manual delete writes a 'delete' row with the last-known (qty 3) snapshot and a null after",
    );

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
