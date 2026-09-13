import { test, expect } from "@playwright/test";

// Phase 6 task 6.7 — the expandable mobile-card substitute for a table row
// (task 6.5, ui/MobileCard.tsx) on the two tables it's wired into so far:
// Roster and the EP Ledger. Confirms the breakpoint swap actually happens
// (table hidden, cards shown, no horizontal page overflow) and that the
// card's expand/collapse is real keyboard-operable button, not a
// click-only div.
test.use({ storageState: "e2e/.auth/session.json", viewport: { width: 375, height: 800 } });

test("roster shows cards (not the table) on a phone width, with no page overflow", async ({ page }) => {
  await page.goto("/roster");
  await expect(page.locator("table")).toBeHidden();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  // Scoped to "Show details" — a bare button[aria-expanded] also matches
  // the mobile top bar's own hamburger toggle (Sidebar.tsx), which sits
  // earlier in the DOM and isn't a roster row at all.
  const firstCardToggle = page.getByRole("button", { name: "Show details" }).first();
  await expect(firstCardToggle).toBeVisible();
});

test("a roster card expands via keyboard and exposes its detail fields", async ({ page }) => {
  await page.goto("/roster");
  // A regex covers both accessible names (MobileCard relabels the button
  // "Show details" ⇄ "Hide details" on toggle) so this keeps resolving to
  // the same first card's button across the state change, rather than
  // silently matching a different, still-collapsed card once the name flips.
  const toggle = page.getByRole("button", { name: /show details|hide details/i }).first();
  const card = page.locator("div.rounded-lg.border.border-border").filter({ has: toggle });
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Hide details");
  // The detail panel names the fields the collapsed table columns carried,
  // scoped to this one card so it can't match the (hidden) desktop table's
  // own "Role" column header.
  await expect(card.getByText("Role", { exact: true })).toBeVisible();
  await expect(card.getByText("Owner", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "View / manage account" })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the EP ledger shows cards (not the table) on a phone width", async ({ page }) => {
  // /epgp/ledger defaults to the Totals tab (TotalsTable — out of scope for
  // task 6.5's card treatment); the EP tab renders LedgerTable.
  await page.goto("/epgp/ledger?type=ep");
  await expect(page.locator("table")).toBeHidden();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

for (const width of [320, 390, 768]) {
  test(`roster has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/roster");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}

test("the sidebar renders as a row alongside <main> at desktop width (768px+)", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/characters");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  await expect(page.locator("aside")).toBeVisible();
});
