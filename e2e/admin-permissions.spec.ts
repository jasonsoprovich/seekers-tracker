import { expect, test } from "@playwright/test";

// The admin-only Permissions matrix (2026-09-19 guild leader request). Every
// test that toggles a cell ends by resetting to defaults, so the shared
// local D1 the whole e2e suite runs against is never left with a stray
// override row.

test.describe("permissions page access", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("officer is redirected away from /admin/permissions", async ({ page }) => {
    await page.goto("/admin/permissions");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("link", { name: "Permissions" })).toHaveCount(0);
  });
});

test.describe("permissions page access (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("leader is redirected away from /admin/permissions", async ({ page }) => {
    await page.goto("/admin/permissions");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("link", { name: "Permissions" })).toHaveCount(0);
  });
});

test.describe("admin workflow", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("sees the Access Control card and can open the matrix", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Access Control" })).toBeVisible();
    await page.getByRole("link", { name: "Permissions" }).click();
    await expect(page).toHaveURL(/\/admin\/permissions$/);
    await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
    await expect(page.getByText("Remove / reinstate a member from the guild")).toBeVisible();
  });

  test("locks the Member column on a high-risk row", async ({ page }) => {
    await page.goto("/admin/permissions");
    const row = page.locator("tr", { has: page.getByText("Remove / reinstate a member from the guild") });
    const memberCell = row.getByRole("checkbox").first();
    await expect(memberCell).toBeDisabled();
    await expect(memberCell).not.toBeChecked();
  });

  test("toggling a cell, saving, and resetting round-trips cleanly", async ({ page }) => {
    await page.goto("/admin/permissions");
    // "Change EPGP settings" defaults to leader-only — Officer starts
    // unchecked, so checking it is an unambiguous, reversible change.
    const row = page.locator("tr", { has: page.getByText("Change EPGP settings") });
    const officerCell = row.getByRole("checkbox").nth(1); // Member, Officer, Leader, Admin — Officer is index 1
    await expect(officerCell).not.toBeChecked();

    await officerCell.check();
    await expect(page.getByRole("button", { name: /Save changes \(1\)/ })).toBeVisible();
    await page.getByRole("button", { name: /Save changes/ }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(officerCell).toBeChecked();

    await page.reload();
    await expect(row.getByRole("checkbox").nth(1)).toBeChecked();

    // Clean up — resetting also proves "Reset all to defaults" actually
    // reverts a stored override, not just the client-side draft state.
    await page.getByRole("button", { name: "Reset all to defaults" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(row.getByRole("checkbox").nth(1)).not.toBeChecked();

    await page.reload();
    await expect(row.getByRole("checkbox").nth(1)).not.toBeChecked();
  });
});
