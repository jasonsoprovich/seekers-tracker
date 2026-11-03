import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// 2026-11-03: level 61-65 spell tracking — the character Spells tab (check
// off + Zeal import), the /spells class grid (officer edit mode, guild-wide
// hide). Every test puts back what it changes.

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8")) as { managedCharacterId: number };
// The managed fixture character is a Cleric (class 1); Faith and Virtue are
// Cleric 61/62 spells, Pacification is Cleric 65.
const CHAR = fixtures.managedCharacterId;
const CHAR_NAME = "E2E Managed Character";

function spellRow(page: Page, name: string) {
  return page.locator("div.border-t", { has: page.getByText(name, { exact: true }) }).first();
}

test.describe("as admin", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("spells tab check-off is instant and persists", async ({ page }) => {
    await page.goto(`/characters/${CHAR}/spells`);
    await expect(page.getByText("Level 61", { exact: true })).toBeVisible();
    const row = spellRow(page, "Faith");
    await expect(row.getByTitle("Mark scribed")).toBeVisible();

    await row.getByTitle("Mark scribed").click();
    await expect(row.getByTitle("Mark missing")).toBeVisible({ timeout: 300 });
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(spellRow(page, "Faith").getByTitle("Mark missing")).toBeVisible();

    await spellRow(page, "Faith").getByTitle("Mark missing").click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(spellRow(page, "Faith").getByTitle("Mark scribed")).toBeVisible();
  });

  test("zeal spellbook import previews, adds only, and tags rows", async ({ page }) => {
    await page.goto(`/characters/${CHAR}/spells`);
    await page.getByText("Import from Zeal spellbook export").click();
    await page
      .getByPlaceholder(/Index\tSpellId/)
      .fill("Index\tSpellId\tLevel\tName\n1\t3296\t61\tFaith\n2\t3467\t62\tVirtue\n3\t202\t1\tCourage\n");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText(/2 on this class.s 61–65 list, 2 new/)).toBeVisible();
    await page.getByRole("button", { name: "Add 2 spells" }).click();
    await expect(page.getByText("Added 2 spells.")).toBeVisible();

    await page.reload();
    for (const name of ["Faith", "Virtue"]) {
      await expect(spellRow(page, name).getByTitle("Mark missing")).toBeVisible();
      await expect(spellRow(page, name).getByText("zeal", { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: "test-results/spells-tab.png", fullPage: true });

    for (const name of ["Faith", "Virtue"]) {
      const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/spells"));
      await spellRow(page, name).getByTitle("Mark missing").click();
      await saved;
    }
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(spellRow(page, "Faith").getByTitle("Mark scribed")).toBeVisible();
    await expect(spellRow(page, "Virtue").getByTitle("Mark scribed")).toBeVisible();
  });

  test("grid edit mode flips a cell for a member", async ({ page }) => {
    await page.goto("/spells");
    await page.getByRole("button", { name: /^CLR/ }).click();
    await page.getByRole("button", { name: "Mains + alts" }).click();
    await page.getByLabel("Recently active").selectOption("all");
    const cell = page.getByTitle(`${CHAR_NAME} — Pacification: missing`);
    await expect(cell).toBeDisabled();

    await page.getByRole("button", { name: "Edit mode" }).click();
    await cell.click();
    await expect(page.getByTitle(`${CHAR_NAME} — Pacification: has it`)).toBeVisible({ timeout: 300 });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "test-results/spells-grid.png", fullPage: true });

    await page.reload();
    await page.getByRole("button", { name: "Mains + alts" }).click();
    await page.getByLabel("Recently active").selectOption("all");
    await page.getByRole("button", { name: "Edit mode" }).click();
    await page.getByTitle(`${CHAR_NAME} — Pacification: has it`).click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.getByRole("button", { name: "Mains + alts" }).click();
    await page.getByLabel("Recently active").selectOption("all");
    await expect(page.getByTitle(`${CHAR_NAME} — Pacification: missing`)).toBeVisible();
  });

  test("hiding a spell drops its column; show hidden brings it back", async ({ page }) => {
    await page.goto("/spells");
    await page.getByRole("button", { name: /^CLR/ }).click();
    const header = page.getByTitle("Faith (level 61)");
    await expect(header).toBeVisible();

    await page.getByTitle(/Hide this spell guild-wide/).first().click();
    await expect(header).toBeHidden();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.getByTitle("Faith (level 61)")).toBeHidden();

    await page.getByLabel(/Show hidden/).check();
    await page.getByTitle("Show this spell guild-wide").first().click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.getByTitle("Faith (level 61)")).toBeVisible();
  });

  test("pre-hidden tradeskill spells are hidden for enchanters", async ({ page }) => {
    await page.goto("/spells");
    await page.getByRole("button", { name: /^ENC/ }).click();
    await expect(page.getByTitle("Imbue Fire (level 65)")).toBeHidden();
    await expect(page.getByTitle("Pacification (level 62)")).toBeVisible();
  });
});

test.describe("as member", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("grid is read-only with no officer controls", async ({ page }) => {
    await page.goto("/spells");
    await expect(page.getByRole("heading", { name: "Spells 61–65" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit mode" })).toHaveCount(0);
    await expect(page.getByTitle(/Hide this spell guild-wide/)).toHaveCount(0);
  });
});

test.describe("layout", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  for (const route of ["/spells", `/characters/${CHAR}/spells`]) {
    for (const width of [320, 390, 768]) {
      test(`${route} has no horizontal overflow at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth, `${route} at ${width}px overflowed`).toBeLessThanOrEqual(clientWidth);
      });
    }
  }
});
