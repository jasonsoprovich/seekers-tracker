import { test, expect } from "@playwright/test";

// Phase 6 task 6.7 — the mobile nav drawer (Sidebar.tsx's MobileNavDrawer,
// task 6.2): a real <dialog> opened via showModal(), so focus trap/Escape/
// restoration all come from the browser's own spec-compliant
// implementation rather than hand-rolled logic (same choice as
// ui/ConfirmDialog.tsx). These tests exercise that contract directly.
//
// Requires e2e/.auth/session.json — run `npx tsx scripts/e2e-auth-setup.ts`
// first (mints a real session against local D1; see that script's own
// comment for why this doesn't need Discord OAuth).
test.use({ storageState: "e2e/.auth/session.json", viewport: { width: 375, height: 800 } });

test("opens as a full-viewport modal dialog and lists every nav link", async ({ page }) => {
  await page.goto("/characters");
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Roster" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Admin" })).toBeVisible();
});

test("focus lands inside the dialog on open and Escape restores it to the toggle button", async ({ page }) => {
  await page.goto("/characters");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await toggle.click();

  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  // autoFocus on the close button — see MobileNavDrawer.
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Native <dialog> close() restores focus to whatever had it before
  // showModal() — the element the user actually activated.
  await expect(toggle).toBeFocused();
});

test("Tab cycles focus without ever leaving the open dialog", async ({ page }) => {
  await page.goto("/characters");
  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const stillInside = await dialog.evaluate((el, active) => el.contains(active), await page.evaluateHandle(() => document.activeElement));
    expect(stillInside).toBe(true);
  }
});

test("clicking a nav link closes the drawer and navigates", async ({ page }) => {
  await page.goto("/characters");
  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await dialog.getByRole("link", { name: "Roster" }).click();
  await expect(page).toHaveURL(/\/roster$/);
  await expect(dialog).toBeHidden();
});

test("respects prefers-reduced-motion without breaking the open/close interaction", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/characters");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
