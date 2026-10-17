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

// 2026-10-17: a check-off shows immediately (optimistic), not after the
// save + page refresh round trip, and still persists. Reverts itself.
test("pop check-off is instant and persists", async ({ page }) => {
  await page.goto("/characters/3375/pop");
  const first = page.getByTitle("Mark done", { exact: true }).first();
  const row = first.locator("xpath=..");
  const label = (await row.locator("span.text-sm").first().textContent())!.trim();
  const rowFor = () => page.locator("div.items-start.border-t", { has: page.getByText(label, { exact: true }) }).first();

  await first.click();
  await expect(rowFor().getByTitle("Mark not done")).toBeVisible({ timeout: 300 });

  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(rowFor().getByTitle("Mark not done")).toBeVisible();

  await rowFor().getByTitle("Mark not done").click();
  await expect(rowFor().getByTitle("Mark done")).toBeVisible({ timeout: 300 });
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(rowFor().getByTitle("Mark done")).toBeVisible();
});

test("pop page links to the pq-companion import tab", async ({ page }) => {
  await page.goto("/characters/3375/pop");
  await page.getByRole("link", { name: "Import from pq-companion" }).click();
  await expect(page).toHaveURL(/\/characters\/3375\/import\?tab=pqc/);
  await expect(page.getByText(/open PoP Flagging and use Export/)).toBeVisible();
});
