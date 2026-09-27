import { expect, test } from "@playwright/test";

// 2026-09-27 unverified-item tracking: the guild bank's item-level Audit
// tab is now officer/leader/admin-only (epgp.bank.audit.view — was
// member-visible). This is the one behavior change here that's genuinely
// worth a real browser check rather than just tsc/build: a member hitting
// ?tab=audit directly must fall back to Browse server-side, not just have
// the tab link hidden client-side.

test.describe("member", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("sees no Audit tab link on /bank", async ({ page }) => {
    await page.goto("/bank");
    await expect(page.getByRole("heading", { name: "Guild Bank" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
  });

  test("?tab=audit falls back to Browse, not the audit table", async ({ page }) => {
    await page.goto("/bank?tab=audit");
    await expect(page.getByRole("heading", { name: "Guild Bank" })).toBeVisible();
    // Browse's search box; the Audit tab's search box has different
    // placeholder text ("Holder, item, officer…") — confirms Browse
    // actually rendered, not just that the audit table happened to be empty.
    await expect(page.getByPlaceholder("Item, holder, or main…")).toBeVisible();
    await expect(page.getByPlaceholder("Holder, item, officer…")).toHaveCount(0);
  });
});

test.describe("officer", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("sees and can open the Audit tab", async ({ page }) => {
    await page.goto("/bank");
    const auditLink = page.getByRole("link", { name: "Audit", exact: true });
    await expect(auditLink).toBeVisible();
    await auditLink.click();
    await expect(page.getByPlaceholder("Holder, item, officer…")).toBeVisible();
  });

  // 2026-09-27, Jason's own call: manual add is hidden (not removed —
  // BANK_MANUAL_ADD_ENABLED in src/lib/bank/constants.ts) so sync stays
  // the one real source of new guild bank items.
  test("does not see the manual + Add item button", async ({ page }) => {
    await page.goto("/bank");
    await expect(page.getByRole("button", { name: "+ Add item" })).toHaveCount(0);
  });
});
