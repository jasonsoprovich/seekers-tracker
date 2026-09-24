import { expect, test, type Page } from "@playwright/test";

const bid = (characterName: string, tier: string, priorityRating: number) => ({
  characterName,
  tier,
  priorityRating,
  occurredAt: "2026-09-15T01:00:00.000Z",
});

async function disableLiveSocket(page: Page) {
  await page.routeWebSocket("**/api/live-bids/ws", () => {});
}

test.describe("live bid board", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("limits active rounds to their bid count while retaining resolved details", async ({ page }) => {
    await disableLiveSocket(page);
    await page.route("**/api/live-bids/state", (route) =>
      route.fulfill({
        json: {
          type: "state",
          collectingDetail: "limited",
          rounds: [
            {
              itemName: "Collecting Item",
              officerName: "Officer",
              // The server only sends a limited-mode viewer their OWN bids
              // (2026-09-23) — an empty array here stands in for "this
              // viewer hasn't bid on this item" while bidCount still
              // reflects the round's true total.
              bids: [],
              bidCount: 2,
              winners: [],
              status: "live",
              lastSeenAt: Date.now(),
              startedAt: 1,
            },
            {
              itemName: "Finalized Item",
              officerName: "Officer",
              bids: [bid("Winner", "High Bid", 4.2)],
              bidCount: 1,
              winners: [bid("Winner", "High Bid", 4.2)],
              status: "resolved",
              lastSeenAt: Date.now(),
              startedAt: 1,
            },
          ],
        },
      }),
    );
    await page.goto("/live-bids");

    await expect(page.getByText("2 bids received")).toBeVisible();
    await expect(page.getByText("Hidden Bidder")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Finalized Item" })).toBeVisible();
  });

  test("grid keeps each card's own height when a neighbor expands", async ({ page }) => {
    // 2026-09-22 live-test feedback: expanding a resolved card's bid table
    // used to stretch every other card in its row to match (a plain CSS
    // grid stretches by default) — a short card grew a block of blank space
    // at the bottom. Fixed with `items-start` on the grid; this proves it by
    // measuring a short neighbor's height before and after a long card next
    // to it expands.
    await disableLiveSocket(page);
    const longBids = Array.from({ length: 8 }, (_, i) => bid(`Bidder${i}`, "Low Bid", i));
    await page.route("**/api/live-bids/state", (route) =>
      route.fulfill({
        json: {
          type: "state",
          collectingDetail: "full",
          rounds: [
            {
              itemName: "Short",
              officerName: "One",
              bids: [bid("A", "High Bid", 5)],
              bidCount: 1,
              winners: [bid("A", "High Bid", 5)],
              status: "resolved",
              lastSeenAt: 40,
              startedAt: 10,
            },
            {
              itemName: "Long",
              officerName: "Two",
              bids: longBids,
              bidCount: longBids.length,
              winners: [longBids[0]],
              status: "resolved",
              lastSeenAt: 50,
              startedAt: 20,
            },
          ],
        },
      }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/live-bids");
    await expect(page.locator("article")).toHaveCount(2);

    const grid = page.locator("article").first().locator("xpath=..");
    await expect(grid).toHaveCSS("display", "grid");
    // Chromium reports Tailwind's `items-start` (align-items: start) back as
    // "flex-start" — the point being tested is that it isn't the grid
    // default (`stretch`, which is what caused the reported bug).
    await expect(grid).not.toHaveCSS("align-items", "stretch");

    const shortCard = page.locator("article", { hasText: "Short" });
    const heightBefore = (await shortCard.boundingBox())!.height;

    await page.locator("article", { hasText: "Long" }).getByRole("button", { name: /Show all \d+ bids/ }).click();
    await expect(page.getByText(`Bidder${longBids.length - 1}`)).toBeVisible();

    const heightAfter = (await shortCard.boundingBox())!.height;
    expect(heightAfter).toBe(heightBefore);
  });
});

test.describe("live bid admin control", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("is available to leaders and persists a detail-mode change", async ({ page }) => {
    let collectingDetail = "full";
    await page.route("**/api/live-bids/config", async (route) => {
      if (route.request().method() === "POST") {
        collectingDetail = (route.request().postDataJSON() as { collectingDetail: string }).collectingDetail;
      }
      await route.fulfill({ json: { collectingDetail } });
    });
    await page.goto("/admin");
    await page.getByRole("button", { name: "Limited" }).click();
    await expect(page.getByText("Limited is active.")).toBeVisible();
  });
});

test.describe("live bid officer restrictions", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("does not render the leader control", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("Live bid detail")).toHaveCount(0);
  });
});
