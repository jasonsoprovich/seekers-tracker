import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8")) as {
  departedCharacterId: number;
};

test.use({ storageState: "e2e/.auth/leader.json" });

test("Claim a Character opens with more than 100 account groups", async ({ page }) => {
  await page.goto("/characters");
  await page.getByRole("link", { name: "Claim a Character" }).click();

  await expect(page.getByRole("heading", { name: "Claim a Character" })).toBeVisible();
  await expect(page.getByText("E2E Claim Group 101", { exact: false })).toBeVisible();
});

test("mules nest under the account main without a character main pointer", async ({ page }) => {
  await page.goto("/characters");
  const yourMule = page.getByRole("listitem").filter({ hasText: "E2E Managed Mule" });
  await expect(yourMule.getByText("(Mule)", { exact: true })).toBeVisible();

  await page.goto("/roster");
  await page.getByRole("textbox", { name: "Search" }).fill("E2E Managed Mule");

  const rows = page.locator("tbody tr");
  await expect(rows.filter({ hasText: "E2E Managed Character" })).toBeVisible();
  const muleRow = rows.filter({ hasText: "E2E Managed Mule" });
  await expect(muleRow).toBeVisible();
  await expect(muleRow.getByText("Mule", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const names = await rows.locator("td:first-child").allTextContents();
      return names.findIndex((name) => name.includes("E2E Managed Character")) < names.findIndex((name) => name.includes("E2E Managed Mule"));
    })
    .toBe(true);
});

test("departed accounts show removal state without a member role control", async ({ page }) => {
  await page.goto("/roster");
  await page.getByRole("combobox", { name: "Status" }).selectOption("all");
  await page.getByRole("textbox", { name: "Search" }).fill("E2E Departed Character");
  const row = page.locator("tbody tr").filter({ hasText: "E2E Departed Character" });
  await expect(row.getByText("Removed from guild", { exact: true })).toBeVisible();
  await expect(row.getByText("Member", { exact: true })).toHaveCount(0);

  await page.goto(`/characters/${fixtures.departedCharacterId}/account`);
  await expect(page.getByText("Removed", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Member", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

test("class disclosure has OR semantics and empty-state reset restores defaults", async ({ page }) => {
  await page.goto("/roster");
  await page.getByText("All classes", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Cleric", exact: true }).check();
  await page.getByRole("checkbox", { name: "Wizard", exact: true }).check();
  await page.getByRole("textbox", { name: "Search" }).fill("E2E Managed");

  const rows = page.locator("tbody tr");
  await expect(rows.filter({ hasText: "E2E Managed Character" })).toBeVisible();
  await expect(rows.filter({ hasText: "E2E Managed Mule" })).toBeVisible();

  await page.getByRole("textbox", { name: "Search" }).fill("no such roster character");
  const emptyRow = page.locator("tbody tr").filter({ hasText: "No characters match these filters." });
  await expect(emptyRow).toBeVisible();
  await emptyRow.getByRole("button", { name: "Reset filters" }).click();

  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue("");
  await expect(rows.filter({ hasText: "E2E Managed Character" })).toBeVisible();
});

test("class disclosure remains accessible at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/roster");
  await page.getByText("All classes", { exact: true }).click();
  await expect(page.getByRole("group", { name: "Class filters" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Cleric", exact: true })).toBeVisible();
});
