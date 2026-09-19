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

  test("explains hidden collecting mode while retaining resolved results", async ({ page }) => {
    await disableLiveSocket(page);
    await page.route("**/api/live-bids/state", (route) =>
      route.fulfill({
        json: {
          type: "state",
          showCollecting: false,
          rounds: [
            {
              itemName: "Finalized Item",
              officerName: "Officer",
              bids: [bid("Winner", "High Bid", 4.2)],
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

    await expect(page.getByText("Live collecting rounds are temporarily hidden by leadership.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finalized Item" })).toBeVisible();
  });

  test("uses natural-height columns without changing DOM order", async ({ page }) => {
    await disableLiveSocket(page);
    await page.route("**/api/live-bids/state", (route) =>
      route.fulfill({
        json: {
          type: "state",
          showCollecting: true,
          rounds: [
            { itemName: "First", officerName: "One", bids: [bid("A", "High Bid", 5)], winners: [], status: "live", lastSeenAt: 40, startedAt: 10 },
            { itemName: "Second", officerName: "Two", bids: [bid("B", "Low Bid", 2), bid("C", "Alt Loot", 1)], winners: [], status: "idle", lastSeenAt: 50, startedAt: 20 },
            { itemName: "Third", officerName: "Three", bids: [bid("D", "High Bid", 4)], winners: [bid("D", "High Bid", 4)], status: "resolved", lastSeenAt: 60, startedAt: 30 },
          ],
        },
      }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/live-bids");
    await expect(page.locator("article")).toHaveCount(3);

    const layout = await page.locator("article").first().evaluate((article) => ({
      order: [...article.parentElement!.children].map((element) => element.querySelector("h2")?.textContent),
      columns: getComputedStyle(article.parentElement!).columnCount,
      breakInside: getComputedStyle(article).breakInside,
    }));
    expect(layout.order).toEqual(["First", "Second", "Third"]);
    expect(Number(layout.columns)).toBeGreaterThan(1);
    expect(layout.breakInside).toBe("avoid");
  });
});

test.describe("live bid admin control", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("is available to leaders and persists a visibility change", async ({ page }) => {
    let showCollecting = true;
    await page.route("**/api/live-bids/config", async (route) => {
      if (route.request().method() === "POST") {
        showCollecting = (route.request().postDataJSON() as { showCollecting: boolean }).showCollecting;
      }
      await route.fulfill({ json: { showCollecting } });
    });
    await page.goto("/admin");
    await page.getByRole("button", { name: "Hide collecting rounds" }).click();
    await expect(page.getByText("Collecting rounds are hidden; resolved rounds are still visible.")).toBeVisible();
  });
});

test.describe("live bid officer restrictions", () => {
  test.use({ storageState: "e2e/.auth/officer.json" });

  test("does not render the leader control", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("Live collecting rounds")).toHaveCount(0);
  });
});
