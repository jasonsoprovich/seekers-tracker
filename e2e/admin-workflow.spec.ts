import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8")) as { managedCharacterId: number };
const accountPath = `/characters/${fixtures.managedCharacterId}/account`;

test.describe("member workflow", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("keeps roster and account details read-only", async ({ page }) => {
    await page.goto("/roster");
    await expect(page.locator("table").getByText("Claim pending", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View / manage account" })).toHaveCount(0);

    await page.goto(accountPath);
    await expect(page.getByText("1 claim is awaiting officer review.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review claims" })).toHaveCount(0);
    await expect(page.getByText("Link a character to E2E Managed Character")).toHaveCount(0);
    await expect(page.getByText("Guild membership", { exact: true })).toHaveCount(0);
  });
});

test.describe("officer workflow", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("can enter account management and follow the claim queue", async ({ page }) => {
    await page.goto("/roster");
    await expect(page.getByRole("link", { name: "View / manage account" }).first()).toBeVisible();

    await page.goto(accountPath);
    await expect(page.getByRole("link", { name: "Review claims" })).toBeVisible();
    await expect(page.getByText("Link a character to E2E Managed Character")).toBeVisible();
    await expect(page.getByText("Guild membership", { exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Review claims" }).click();
    await expect(page).toHaveURL(/\/admin\/claims$/);
    await expect(page.getByRole("heading", { name: "Claim Requests" })).toBeVisible();
  });
});

test.describe("leader workflow", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("shows leader-only account controls", async ({ page }) => {
    await page.goto(accountPath);
    await expect(page.getByRole("combobox").filter({ has: page.getByRole("option", { name: "leader (you)" }) })).toBeVisible();
    await expect(page.getByText("Guild membership", { exact: true })).toBeVisible();
  });
});

test.describe("admin workflow", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("matches the leader account-management controls", async ({ page }) => {
    await page.goto(accountPath);
    await expect(page.locator("select").filter({ hasText: "leader" })).toBeVisible();
    await expect(page.getByText("Guild membership", { exact: true })).toBeVisible();
  });
});
