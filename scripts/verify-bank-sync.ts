// PLAN.md §9/§11 Phase 8.4 — guild bank sync end-to-end verification.
// Extended 2026-09-25 for the officer-feedback pass: per-item (sub-slot)
// designation, add/remove without clobbering other flags, occupant-driven
// expected_* refresh, the currency purge, and removeUnverifiedHoldings
// (was retireSheetRows). Extended again 2026-09-27 for unverified-item
// reconciliation: sheet/manual rows matched or flagged not-found by a real
// sync, and the audit trail's batchId grouping.
//
// Exercises src/lib/bank/sync.ts's real functions (loadBankConfig,
// updateDesignations, saveEqAccount, deleteEqAccount, validateSyncPayload,
// previewSync, applySync, removeUnverifiedHoldings, reconcileUnverified)
// against local D1, same pattern as verify-guild-removal.ts: synthetic
// users/characters/holdings, snapshotted first and restored in a `finally`
// regardless of outcome. Never point this at remote D1 (PLAN.md §5).
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
  reconcileUnverified,
  removeUnverifiedHoldings,
  saveEqAccount,
  updateDesignations,
  validateSyncPayload,
  type SyncHolderInput,
  type UnverifiedHoldingRow,
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
    .select({
      id: bankHoldings.id,
      container: bankHoldings.container,
      slotIndex: bankHoldings.slotIndex,
      itemName: bankHoldings.itemName,
      quantity: bankHoldings.quantity,
      category: bankHoldings.category,
      status: bankHoldings.status,
      note: bankHoldings.note,
      source: bankHoldings.source,
      importId: bankHoldings.importId,
      legacyLocation: bankHoldings.legacyLocation,
      notFoundSince: bankHoldings.notFoundSince,
    })
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
    // re-syncing is idempotent. A sync's DELETE step only ever touches
    // VERIFIED rows (source='import' AND import_id IS NOT NULL) now — an
    // unverified row's fate is reconciliation (Scenario 9), never a plain
    // replace-in-place, so nothing unverified is seeded here.
    // ---------------------------------------------------------------
    console.log("\nScenario 4: real sync + manual rows preserved + idempotent re-sync");
    await db.insert(bankHoldings).values([
      { holderCharacterId: muleId, category: "item", container: "Manual", slotIndex: 1, itemName: "Hand-added item", quantity: 1, status: "guild_bank", source: "manual" },
    ]);

    let applied1 = await applySync(db, actor.id, [validPayload], config);
    check(failures, applied1.diffs[0]?.added.length === 3, `first sync adds all 3 rows (nothing verified existed yet) (got ${applied1.diffs[0]?.added.length})`);

    const afterSync1 = await holdingsFor(db, muleId);
    check(failures, afterSync1.length === 4, `4 rows exist after sync: 3 verified + 1 manual (got ${afterSync1.length})`);
    const manualRow = afterSync1.find((r) => r.source === "manual");
    check(failures, manualRow?.itemName === "Hand-added item", "the manual row survived the sync untouched");
    const bank1Slot0 = afterSync1.find((r) => r.container === "Bank1" && r.slotIndex === 0);
    check(failures, bank1Slot0?.itemName === "Test Ore", "the synced item landed at Bank1 slot 0");

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
    // Scenario 6c: removeUnverifiedHoldings (was retireSheetRows) removes
    // only unverified (source='manual', or source='import' with a NULL
    // import_id) rows, never a real synced row, requires a note, and
    // writes an audited bank_audit_log 'delete' row (batched when more
    // than one row).
    // ---------------------------------------------------------------
    console.log("\nScenario 6c: removeUnverifiedHoldings");
    await db.insert(bankHoldings).values([
      // Migration 0053's own convention: sheet rows live under the
      // synthetic "Sheet" container with a legacy_location preserving the
      // original position — see that migration's own comment.
      { holderCharacterId: soloId, category: "item", container: "Sheet", slotIndex: 1, itemName: "Sheet-only item A", quantity: 1, status: "guild_bank", source: "import", importId: null, legacyLocation: "Bank1" },
      { holderCharacterId: soloId, category: "item", container: "Sheet", slotIndex: 2, itemName: "Sheet-only item B", quantity: 1, status: "guild_bank", source: "import", importId: null, legacyLocation: "Bank2" },
    ]);
    const soloBeforeRemove = await holdingsFor(db, soloId);
    check(failures, soloBeforeRemove.length === 2, "two unverified sheet rows exist for the solo character before removal");

    const emptyNoteResult = await removeUnverifiedHoldings(db, { kind: "holder", holderCharacterId: soloId }, "   ", actor.id);
    check(failures, !!emptyNoteResult.error && emptyNoteResult.removed === 0, "removeUnverifiedHoldings refuses an empty/blank note and removes nothing");

    const removeAll = await removeUnverifiedHoldings(db, { kind: "holder", holderCharacterId: soloId }, "cleanup — never got a real sync", actor.id);
    check(failures, removeAll.removed === 2, `removeUnverifiedHoldings(holder) removed exactly its 2 unverified rows (got ${removeAll.removed})`);
    const soloAfterRemove = await holdingsFor(db, soloId);
    check(failures, soloAfterRemove.length === 0, "the solo character's holdings are empty after removal");
    const muleAfterRemove = await holdingsFor(db, muleId);
    check(failures, muleAfterRemove.length === 1 && muleAfterRemove[0].source === "manual", "removing a different holder's unverified rows left the mule's manual row alone");

    const soloRemoveAudit = await db.select().from(bankAuditLog).where(eq(bankAuditLog.holderCharacterId, soloId)).orderBy(bankAuditLog.id);
    check(failures, soloRemoveAudit.length === 2, `removeUnverifiedHoldings wrote one 'delete' audit row per removed item (got ${soloRemoveAudit.length})`);
    check(
      failures,
      soloRemoveAudit.every((r) => r.action === "delete" && r.source === "manual" && r.note === "cleanup — never got a real sync"),
      "every removal audit row carries the required note",
    );
    check(
      failures,
      soloRemoveAudit[0].batchId !== null && soloRemoveAudit[0].batchId === soloRemoveAudit[1].batchId,
      "a multi-row removal shares one batchId across its audit rows",
    );

    // Single-row removal (kind: "row") doesn't batch — batchId stays null.
    const [singleRow] = await db
      .insert(bankHoldings)
      .values({ holderCharacterId: soloId, category: "item", container: "Manual", slotIndex: 1, itemName: "Solo Manual Item", quantity: 1, status: "guild_bank", source: "manual" })
      .returning({ id: bankHoldings.id });
    const removeSingle = await removeUnverifiedHoldings(db, { kind: "row", id: singleRow.id }, "given to Kessra", actor.id);
    check(failures, removeSingle.removed === 1, "removeUnverifiedHoldings(row) removes exactly the one targeted row");
    const singleAudit = await db.select().from(bankAuditLog).where(eq(bankAuditLog.holdingId, singleRow.id));
    check(failures, singleAudit.length === 1 && singleAudit[0].batchId === null, "a single-row removal's audit row has no batchId");

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

    // ---------------------------------------------------------------
    // Scenario 9: unverified (sheet/manual) row reconciliation — 2026-09-27.
    // Exact-location match, name-only match, partial-quantity match,
    // not-found flagging (and clearing on a later sync that finally
    // matches), a manual row picked up the same way a sheet row is, and
    // the 'verify' audit rows (with a shared batchId) replacing an
    // unrelated remove+add pair for the matched slots.
    // ---------------------------------------------------------------
    console.log("\nScenario 9: unverified row reconciliation");
    const reconcileId = await makeCharacter(db, `VerifyReconcile-${randomUUID().slice(0, 8)}`);
    let rResult = await updateDesignations(db, actor.id, { characterId: reconcileId }, {
      set: [
        { container: "Bank1", slotIndex: 0 },
        { container: "Bank2", slotIndex: 0 },
        { container: "Bank3", slotIndex: 0 },
        { container: "Bank4", slotIndex: 0 },
        { container: "Bank5", slotIndex: 0 },
      ],
    });
    check(failures, !rResult.error, `designations set for reconciliation test (${rResult.error ?? "ok"})`);

    await db.insert(bankHoldings).values([
      { holderCharacterId: reconcileId, category: "item", container: "Sheet", slotIndex: 1, itemName: "ExactLoc Item", quantity: 4, status: "guild_bank", source: "import", importId: null, legacyLocation: "Bank1" },
      { holderCharacterId: reconcileId, category: "item", container: "Sheet", slotIndex: 2, itemName: "NameOnly Item", quantity: 3, status: "guild_bank", source: "import", importId: null, legacyLocation: "General5" },
      { holderCharacterId: reconcileId, category: "item", container: "Sheet", slotIndex: 3, itemName: "Partial Item", quantity: 10, status: "guild_bank", source: "import", importId: null, legacyLocation: null },
      { holderCharacterId: reconcileId, category: "item", container: "Sheet", slotIndex: 4, itemName: "Ghost Item", quantity: 2, status: "guild_bank", source: "import", importId: null, legacyLocation: "Bank9" },
      { holderCharacterId: reconcileId, category: "item", container: "Manual", slotIndex: 1, itemName: "Manual Pickup", quantity: 1, status: "guild_bank", source: "manual" },
    ]);

    const reconcilePayload1: SyncHolderInput = {
      characterId: reconcileId,
      sourceFile: "Reconcile-Inventory.txt",
      reportsSharedBank: false,
      rows: [
        { container: "Bank1", slotIndex: 0, category: "item", itemName: "ExactLoc Item", itemId: 2001, quantity: 4 },
        { container: "Bank2", slotIndex: 0, category: "item", itemName: "NameOnly Item", itemId: 2002, quantity: 3 },
        { container: "Bank3", slotIndex: 0, category: "item", itemName: "Partial Item", itemId: 2003, quantity: 4 },
        { container: "Bank4", slotIndex: 0, category: "item", itemName: "Manual Pickup", itemId: 2004, quantity: 1 },
      ],
      occupants: [],
    };

    let rConfig = await loadBankConfig(db);
    const rPreview = await previewSync(db, [reconcilePayload1]);
    check(failures, rPreview.diffs[0]?.verified?.length === 4, `previewSync reports 4 verified matches (got ${rPreview.diffs[0]?.verified?.length})`);
    check(failures, rPreview.diffs[0]?.notFound?.length === 1, `previewSync reports 1 not-found row (got ${rPreview.diffs[0]?.notFound?.length})`);
    const beforeReconcileSync = await holdingsFor(db, reconcileId);
    check(failures, beforeReconcileSync.length === 5, "previewSync wrote nothing — still the original 5 unverified rows");

    const rApplied1 = await applySync(db, actor.id, [reconcilePayload1], rConfig);
    check(failures, rApplied1.diffs[0]?.added.length === 4, `sync adds all 4 incoming rows as brand-new verified holdings (got ${rApplied1.diffs[0]?.added.length})`);
    check(failures, rApplied1.diffs[0]?.verified?.length === 4, `sync reports 4 verified matches (got ${rApplied1.diffs[0]?.verified?.length})`);
    check(failures, rApplied1.diffs[0]?.notFound?.length === 1, `sync reports 1 not-found row (got ${rApplied1.diffs[0]?.notFound?.length})`);

    const afterReconcileSync1 = await holdingsFor(db, reconcileId);
    check(failures, afterReconcileSync1.length === 6, `6 rows remain: 4 newly-verified + Partial Item (reduced) + Ghost Item (not found) (got ${afterReconcileSync1.length})`);
    check(failures, !afterReconcileSync1.some((r) => r.itemName === "ExactLoc Item" && r.container === "Sheet"), "the exact-location match's unverified row is gone");
    check(failures, !afterReconcileSync1.some((r) => r.itemName === "NameOnly Item" && r.container === "Sheet"), "the name-only match's unverified row is gone");
    check(failures, !afterReconcileSync1.some((r) => r.itemName === "Manual Pickup" && r.container === "Manual"), "the manual row was picked up by the sync and is gone");
    const partialAfter = afterReconcileSync1.find((r) => r.itemName === "Partial Item" && r.container === "Sheet");
    check(failures, partialAfter?.quantity === 6, `Partial Item's unverified row reduced from 10 to 6 (got ${partialAfter?.quantity})`);
    check(failures, partialAfter?.notFoundSince === null, "a partial match does NOT flag the residual as not-found");
    const ghostAfter = afterReconcileSync1.find((r) => r.itemName === "Ghost Item" && r.container === "Sheet");
    check(failures, ghostAfter?.quantity === 2 && ghostAfter?.notFoundSince !== null, "Ghost Item's unverified row survives unchanged, now flagged not-found");
    // Real synced rows landed correctly too, at the real slots (no unique-
    // index collision with the "Sheet"-container unverified rows).
    check(failures, afterReconcileSync1.some((r) => r.itemName === "ExactLoc Item" && r.container === "Bank1" && r.slotIndex === 0), "the real synced ExactLoc Item landed at Bank1 slot 0");

    // Audit trail: 4 'verify' rows (one per matched slot — the partial
    // match gets one too), sharing one batchId, and NO plain 'create' row
    // for any of those 4 slots (suppressed — the verify row already
    // covers it). No audit row for the not-found flip.
    const reconcileAudit = await db.select().from(bankAuditLog).where(eq(bankAuditLog.holderCharacterId, reconcileId)).orderBy(bankAuditLog.id);
    const verifyRows = reconcileAudit.filter((r) => r.action === "verify");
    check(failures, verifyRows.length === 4, `exactly 4 'verify' audit rows written (got ${verifyRows.length})`);
    check(failures, reconcileAudit.filter((r) => r.action === "create").length === 0, "no plain 'create' rows for the 4 matched slots — the verify rows cover them");
    check(failures, reconcileAudit.length === 4, `no audit row at all for the not-found flip (total rows: ${reconcileAudit.length})`);
    const batchIds = new Set(verifyRows.map((r) => r.batchId));
    check(failures, batchIds.size === 1 && [...batchIds][0] !== null, "all 4 verify rows from this sync share one non-null batchId");
    const partialVerifyRow = verifyRows.find((r) => r.itemName === "Partial Item");
    check(
      failures,
      (partialVerifyRow?.before as { quantity?: number } | null)?.quantity === 10 && (partialVerifyRow?.after as { quantity?: number } | null)?.quantity === 6,
      "the partial match's verify row records before qty 10 / after qty 6",
    );

    // A later sync that finally includes Ghost Item matches and clears it.
    rConfig = await loadBankConfig(db);
    const reconcilePayload2: SyncHolderInput = {
      characterId: reconcileId,
      sourceFile: "Reconcile-Inventory.txt",
      reportsSharedBank: false,
      rows: [
        ...reconcilePayload1.rows,
        { container: "Bank5", slotIndex: 0, category: "item", itemName: "Ghost Item", itemId: 2005, quantity: 2 },
      ],
      occupants: [],
    };
    await applySync(db, actor.id, [reconcilePayload2], rConfig);
    const afterReconcileSync2 = await holdingsFor(db, reconcileId);
    check(failures, !afterReconcileSync2.some((r) => r.itemName === "Ghost Item" && r.container === "Sheet"), "Ghost Item's unverified row is gone once a later sync finally matches it");
    check(failures, afterReconcileSync2.some((r) => r.itemName === "Ghost Item" && r.container === "Bank5"), "the real synced Ghost Item landed at Bank5 slot 0");

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
