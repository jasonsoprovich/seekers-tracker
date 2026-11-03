import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// 2026-11-03: a pq-companion export from its All tab carries every character
// on the PC; one import now updates every roster character in it the
// importer can manage, and lists the rest as skipped. Puts back what it
// changes (deletes the import rows it created).

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8")) as { managedCharacterId: number; characterId: number };
const PAGE_CHAR = fixtures.managedCharacterId; // "E2E Managed Character"
const OTHER_CHAR = fixtures.characterId; // a real roster character the admin can manage
const FLAG = "ponb_preflag";

test.use({ storageState: "e2e/.auth/admin.json" });

function exportJson(otherName: string, done: boolean) {
  const flags = [{ id: FLAG, tier: 1, zone: "Plane of Nightmares", label: "x", done, source: "manual" }];
  return JSON.stringify({
    kind: "pq-companion.popflags",
    version: 1,
    exported_at: "2026-11-03T00:00:00Z",
    characters: [
      { name: otherName, done: 0, total: 1, zones: {}, flags },
      { name: "E2E Managed Character", done: 0, total: 1, zones: {}, flags },
      { name: "Nobodyhere Atall", done: 0, total: 1, zones: {}, flags },
    ],
  });
}

async function preview(page: Page, json: string) {
  await page.goto(`/characters/${PAGE_CHAR}/import?tab=pqc`);
  await page.getByPlaceholder(/pq-companion\.popflags/).fill(json);
  await page.getByRole("button", { name: "Preview import" }).click();
}

function cleanup() {
  execSync(
    `npx wrangler d1 execute seekers-of-souls --local --command "DELETE FROM character_pop_flags WHERE flag_id='${FLAG}' AND source='import' AND character_id IN (${PAGE_CHAR}, ${OTHER_CHAR})"`,
    { stdio: "ignore" },
  );
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

test("one pq-companion export updates every manageable character in it", async ({ page }) => {
  await page.goto(`/characters/${OTHER_CHAR}/pop`);
  const otherName = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();

  await preview(page, exportJson(otherName, true));
  await expect(page.getByText("Changes for 2 characters from this export.")).toBeVisible();
  await expect(page.getByText(/Skipped: Nobodyhere Atall \(not on the roster\)/)).toBeVisible();
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText(/Imported for E2E Managed Character: 1 marked done/)).toBeVisible();
  await expect(page.getByText(new RegExp(`Imported for ${otherName}: 1 marked done`))).toBeVisible();
  await page.screenshot({ path: "test-results/pqc-multi-import.png", fullPage: true });

  // Same file with the flag not done: both get un-checked, behind one confirm.
  await preview(page, exportJson(otherName, false));
  await expect(page.getByText("Yes, un-check these 2 flags")).toBeVisible();
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText(/tick the confirmation box/)).toBeVisible();
  await page.getByLabel("Yes, un-check these 2 flags").check();
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText(/Imported for E2E Managed Character: 0 marked done, 1 un-checked/)).toBeVisible();
  await expect(page.getByText(new RegExp(`Imported for ${otherName}: 0 marked done, 1 un-checked`))).toBeVisible();
});

test("an export with no manageable characters is refused", async ({ page }) => {
  await preview(
    page,
    JSON.stringify({
      kind: "pq-companion.popflags",
      version: 1,
      characters: [{ name: "Nobodyhere Atall", flags: [{ id: FLAG, done: true }] }],
    }),
  );
  await expect(page.getByText(/None of the characters in this export/)).toBeVisible();
});
