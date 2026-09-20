import { expect, test } from "@playwright/test";

// The admin+leader-only System Log & Export page (/admin/logs). Hard-gated
// on LEADERSHIP_ROLES (leader/admin), like /admin/permissions — deliberately
// NOT matrix-tunable, so an officer must never reach it regardless of any
// permissions-matrix edit.

test.describe("system log access (officer)", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("officer is redirected away from /admin/logs and never sees the card", async ({ page }) => {
    await page.goto("/admin/logs");
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "System Log & Export" })).toHaveCount(0);
  });

  test("the export API also refuses an officer", async ({ page }) => {
    const res = await page.request.get("/api/admin/export?table=raids");
    expect(res.status()).toBe(403);
  });
});

test.describe("system log access (member)", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("member is redirected away from /admin/logs", async ({ page }) => {
    await page.goto("/admin/logs");
    await expect(page).toHaveURL(/\/(admin|characters)$/);
  });
});

test.describe("system log workflow (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("sees the Diagnostics card and can open the System Log tab", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
    await page.getByRole("link", { name: "System Log & Export" }).click();
    await expect(page).toHaveURL(/\/admin\/logs/);
    await expect(page.getByRole("heading", { name: "System Log & Export" })).toBeVisible();
  });

  test("category and date filters narrow the table without erroring", async ({ page }) => {
    await page.goto("/admin/logs?tab=log");
    await page.getByLabel("Category").selectOption("membership");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page).toHaveURL(/category=membership/);
    await expect(page.getByRole("heading", { name: "System Log & Export" })).toBeVisible();
  });

  test("switches to the Export tab and lists the table checkboxes", async ({ page }) => {
    await page.goto("/admin/logs?tab=export");
    // exact: true — "EPGP Ledger" (the sidebar nav link) also contains
    // "EP Ledger"/"GP Ledger" as a substring, and the sidebar renders twice
    // (desktop + mobile drawer), so a loose match hits a strict-mode
    // violation across 3 elements.
    await expect(page.getByText("EP Ledger", { exact: true })).toBeVisible();
    await expect(page.getByText("GP Ledger", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Download/ })).toBeDisabled();
  });

  test("the export API streams a CSV for a leader", async ({ page }) => {
    const res = await page.request.get("/api/admin/export?table=raids");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain("attachment");
  });

  test("the export count endpoint returns a row count", async ({ page }) => {
    const res = await page.request.get("/api/admin/export?count=1&tables=raids");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.raids).toBe("number");
  });

  test("an unknown export table key is rejected", async ({ page }) => {
    const res = await page.request.get("/api/admin/export?table=sessions");
    expect(res.status()).toBe(400);
  });
});

test.describe("system log workflow (admin)", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("also sees the Diagnostics card", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "System Log & Export" })).toBeVisible();
  });
});
