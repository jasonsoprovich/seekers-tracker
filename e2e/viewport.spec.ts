import { test, expect } from "@playwright/test";

// Phase 6 task 6.7 — viewport/overflow coverage on a page that needs no
// session at all (Discord OAuth isn't available in any environment this
// suite runs in — see CLAUDE.md's recurring note on every prior
// mobile/auth phase). The four widths PLAN.md's REMEDIATION-PLAN task 6.6
// names for manual validation.
const WIDTHS = [320, 375, 390, 768];

for (const width of WIDTHS) {
  test(`/login has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/login");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await expect(page.getByRole("button", { name: /sign in with discord/i })).toBeVisible();
  });
}

test("/login sign-in button meets the 44px touch-target floor on phones", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/login");
  const box = await page.getByRole("button", { name: /sign in with discord/i }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
