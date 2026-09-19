import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/.auth/session.json" });

test("Your Characters shows server-derived account activity windows", async ({ page }) => {
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Activity summary" })).toBeVisible();
  await expect(page.getByText("24 hours", { exact: true })).toBeVisible();
  await expect(page.getByText("365 days", { exact: true })).toBeVisible();
  await expect(page.getByText("All time", { exact: true })).toBeVisible();
  await expect(page.getByText("EP gained", { exact: true })).toBeVisible();
  await expect(page.getByText("GP spent", { exact: true })).toBeVisible();
});
