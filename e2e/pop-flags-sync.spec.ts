import { expect, test } from "@playwright/test";

// 2026-10-02: level cap 65 + PoP tracker sync with pq-companion (flow view,
// #popflags import tab). Read-only — no data is written.

test.use({ storageState: "e2e/.auth/admin.json" });

test("character form allows level up to 65", async ({ page }) => {
  await page.goto("/characters/new");
  await expect(page.getByLabel(/^Level/)).toHaveAttribute("max", "65");
});

test("pop tracker toggles to the flow chart and back", async ({ page }) => {
  await page.goto("/characters/3375/pop");
  await page.getByRole("button", { name: "Flow chart" }).click();
  await expect(page.getByText("ALL = every source zone required")).toBeVisible();
  await expect(page.getByRole("button", { name: /Plane of Justice/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Plane of Time/ })).toBeVisible();
  await page.screenshot({ path: "test-results/pop-flow.png", fullPage: true });
  await page.getByRole("button", { name: "Checklist" }).click();
  await expect(page.getByText("Tier 1").first()).toBeVisible();
});

test("import page has a #popflags tab", async ({ page }) => {
  await page.goto("/characters/3375/import");
  await expect(page.getByRole("button", { name: "#popflags" })).toBeVisible();
  await expect(page.getByLabel(/#popflags output/)).toBeVisible();
});
