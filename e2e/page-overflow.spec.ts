import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8")) as { characterId: number | null };

// Phase 6 task 6.6 — "Validate Dashboard, Roster, Account/Claims, Live
// Bids, Ledger, and Admin at 320, 375, 390, and 768px widths." A generic
// no-horizontal-overflow sweep across exactly those pages (all of the
// EPGP Ledger's tabs, not just the EP one MobileCard was applied to —
// this is what actually caught the ledger tab bar not wrapping on a
// phone, fixed alongside this test).
test.use({ storageState: "e2e/.auth/session.json" });

const ROUTES = [
  "/dashboard",
  "/roster",
  ...(fixtures.characterId ? [`/characters/${fixtures.characterId}/account`] : []),
  "/live-bids",
  "/epgp/ledger?type=totals",
  "/epgp/ledger?type=ep",
  "/epgp/ledger?type=gp",
  "/epgp/ledger?type=bids",
  "/epgp/ledger?type=audit",
  "/admin",
  "/admin/health",
];

const WIDTHS = [320, 375, 390, 768];

for (const route of ROUTES) {
  for (const width of WIDTHS) {
    test(`${route} has no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${route} at ${width}px overflowed`).toBeLessThanOrEqual(clientWidth);
    });
  }
}
