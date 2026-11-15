import { expect, type Page, test } from "@playwright/test";

// 2026-11-14 /bank class filter. Uses real local bank rows (Darkclaw's
// synced export): Song: Occlusion of Sound (BRD only), Spell: Shroud of
// Death (SHD only), Spell: Blessing of Aegolism (CLR only), Unrefined
// Emerald (no class restriction → shown for every class). Skips if local
// D1 doesn't hold those rows.

test.use({ storageState: "e2e/.auth/member.json" });

const table = (page: Page) => page.locator("table");

async function requireFixtures(page: Page) {
  const has = await table(page).getByText("Song: Occlusion of Sound").count();
  test.skip(has === 0, "local bank has no Darkclaw fixture rows");
}

test("defaults to All classes and shows everything", async ({ page }) => {
  await page.goto("/bank");
  await requireFixtures(page);
  await expect(page.getByLabel("Class")).toHaveValue("all");
  await expect(table(page).getByText("Spell: Shroud of Death")).toBeVisible();
  await expect(table(page).getByText("Spell: Blessing of Aegolism")).toBeVisible();
});

test("?class=brd shows bard songs + all-class items, hides other classes' spells", async ({ page }) => {
  await page.goto("/bank?class=brd");
  await requireFixtures(page);
  await expect(page.getByLabel("Class")).toHaveValue("7");
  await expect(table(page).getByText("Song: Occlusion of Sound")).toBeVisible();
  await expect(table(page).getByText("Unrefined Emerald")).toBeVisible();
  await expect(table(page).getByText("Spell: Shroud of Death")).toHaveCount(0);
  await expect(table(page).getByText("Spell: Blessing of Aegolism")).toHaveCount(0);
});

test("picking a class filters in place and updates the URL", async ({ page }) => {
  await page.goto("/bank");
  await requireFixtures(page);
  await page.getByLabel("Class").selectOption({ label: "Cleric" });
  await expect(page).toHaveURL(/[?&]class=clr\b/);
  await expect(table(page).getByText("Spell: Blessing of Aegolism")).toBeVisible();
  await expect(table(page).getByText("Song: Occlusion of Sound")).toHaveCount(0);

  await page.getByLabel("Class").selectOption("all");
  await expect(page).not.toHaveURL(/class=/);
  await expect(table(page).getByText("Song: Occlusion of Sound")).toBeVisible();
});

test("an unknown ?class value falls back to All", async ({ page }) => {
  await page.goto("/bank?class=nope");
  await expect(page.getByLabel("Class")).toHaveValue("all");
});

test("class + Category=Spell leaves only that class's spells/songs", async ({ page }) => {
  await page.goto("/bank?class=brd");
  await requireFixtures(page);
  await page.getByLabel("Category").selectOption("spell");
  await expect(table(page).getByText("Song: Occlusion of Sound")).toBeVisible();
  await expect(table(page).getByText("Song: Warsong of the Vah Shir")).toBeVisible();
  await expect(table(page).getByText("Unrefined Emerald")).toHaveCount(0);
  await expect(table(page).getByText("Spell: Shroud of Death")).toHaveCount(0);
  // Every remaining row is a spell/song.
  const categories = await table(page).locator("tbody tr td:nth-child(4)").allInnerTexts();
  expect(categories.length).toBeGreaterThan(0);
  for (const c of categories) expect(c.trim().toLowerCase()).toBe("spell");
});
