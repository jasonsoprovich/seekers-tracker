import { expect, test } from "@playwright/test";

// 2026-09-30 leader-team feedback batch: ledger paging, Guild Information
// cards, and the character-edit save staying on the page.

test.describe("ledger pagination (officer)", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("shows numbered pagination and a persistent rows-per-page choice", async ({ page, context }) => {
    await page.goto("/epgp/ledger?type=gp&page=1");
    await expect(page.getByRole("navigation", { name: "Pagination" }).first()).toContainText(/Page 1 of \d+/);
    const size = page.getByLabel("Rows per page");
    await expect(size).toHaveValue("50");
    await size.selectOption("100");
    await expect
      .poll(async () => (await context.cookies()).find((c) => c.name === "ledger_page_size")?.value)
      .toBe("100");
    await page.goto("/epgp/ledger?type=ep&page=1");
    await expect(page.getByLabel("Rows per page")).toHaveValue("100");
    // put it back so later specs see the default
    await page.getByLabel("Rows per page").selectOption("50");
    await expect
      .poll(async () => (await context.cookies()).find((c) => c.name === "ledger_page_size")?.value)
      .toBe("50");
  });

  test("an out-of-range page clamps to the last page", async ({ page }) => {
    await page.goto("/epgp/ledger?type=gp&page=99999");
    await expect(page.getByRole("navigation", { name: "Pagination" }).first()).not.toContainText("Page 99999");
  });

  test("the add form offers an optional existing-event dropdown, not free-text dates", async ({ page }) => {
    await page.goto("/epgp/ledger?type=ep");
    await page.getByRole("button", { name: /Add EP entry/ }).click();
    await expect(page.getByText("Link to event (optional)")).toBeVisible();
    await expect(page.getByText("Raid / event name")).toHaveCount(0);
  });
});

test.describe("guild information (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("leader can add, preview-render, resize, and delete a card", async ({ page }) => {
    await page.goto("/guild-info");
    await page.getByRole("button", { name: "+ Add card" }).click();
    await page.getByLabel("Title").fill("E2E Rules");
    await page.getByLabel("Text").fill("**bold rule**\n<script>alert(1)</script>");
    // preview renders live beside the editor on desktop (tabs only below lg)
    await expect(page.locator(".guild-md strong")).toHaveText("bold rule");
    await expect(page.locator(".guild-md script")).toHaveCount(0);
    await page.getByRole("button", { name: "Add card" }).click();

    const card = page.locator("section", { has: page.getByRole("heading", { name: "E2E Rules" }) });
    await expect(card.locator("strong")).toHaveText("bold rule");
    await card.getByRole("button", { name: "Full width" }).click();
    await expect(card.getByRole("button", { name: "Half width" })).toBeVisible();

    await card.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: "E2E Rules" })).toHaveCount(0);
  });
});

test.describe("guild information (member)", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("members can read the page but get no editing controls", async ({ page }) => {
    await page.goto("/guild-info");
    await expect(page.getByRole("heading", { name: "Guild Information" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add card" })).toHaveCount(0);
  });
});

test.describe("character edit (admin)", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("Save Changes stays on the edit page and confirms", async ({ page }) => {
    await page.goto("/characters/1/edit");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page).toHaveURL(/\/characters\/1\/edit$/);
  });
});
