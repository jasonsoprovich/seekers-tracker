import { expect, test, type Page } from "@playwright/test";

// 2026-09-30 Guild Information overhaul, PQDI item tooltips, and the
// dashboard 14-day filter.

const DISCORD_PASTE = [
  "Examples on how a tagged member can earn EP:",
  "",
  "\t• **Raiding**",
  "\t\t• Raiding attendance requires your MAIN character.",
  "\t\t• There will be times where a class is needed. **If the Event Lead asks you** to play an alt.",
  "",
  "",
  "",
  "\t• **Guild Bank Donation**",
  "\t\t• The guild collects specific items.",
].join("\n");

async function addCard(page: Page, title: string, body: string) {
  await page.goto("/guild-info");
  await page.getByRole("button", { name: "+ Add card" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Text").fill(body);
}

// Submit the open editor and wait until the saved card is on the page, so a
// following navigation can't race the server action.
async function saveCard(page: Page, title: string) {
  await page.getByRole("button", { name: "Add card" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function deleteCard(page: Page, title: string) {
  await page.goto("/guild-info");
  const card = page.locator("section", { has: page.getByRole("heading", { name: title }) });
  await card.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: title })).toHaveCount(0);
}

test.describe("guild information formatting (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("Discord-pasted bullets render as nested lists with gaps, never code blocks", async ({ page }) => {
    await addCard(page, "E2E Discord Paste", DISCORD_PASTE);
    // live preview, before saving
    const preview = page.locator(".guild-md").first();
    await expect(preview.locator("pre, code")).toHaveCount(0);
    await expect(preview.locator("li")).toHaveCount(5);
    await expect(preview.locator("ul ul")).toHaveCount(2);
    await expect(preview.locator(".guild-md-spacer")).toHaveCount(2);
    await expect(preview.locator("strong").first()).toHaveText("Raiding");
    await saveCard(page, "E2E Discord Paste");

    const card = page.locator("section", { has: page.getByRole("heading", { name: "E2E Discord Paste" }) });
    await expect(card.locator("pre")).toHaveCount(0);
    await expect(card.locator("li")).toHaveCount(5);
    await deleteCard(page, "E2E Discord Paste");
  });

  test("toolbar wraps the selection and inserts items/spacers", async ({ page }) => {
    await addCard(page, "E2E Toolbar", "make this bold");
    const area = page.getByLabel("Text");
    await area.focus();
    await area.selectText();
    await page.getByRole("button", { name: "B", exact: true }).click();
    await expect(area).toHaveValue("**make this bold**");
    await page.getByRole("button", { name: "Item", exact: true }).click();
    // the selection is still "make this bold", so Item wraps it
    await expect(area).toHaveValue("**[[make this bold]]**");
    await saveCard(page, "E2E Toolbar");
    await deleteCard(page, "E2E Toolbar");
  });
});

test.describe("guild information on a phone (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json", viewport: { width: 390, height: 844 } });

  test("no horizontal scroll, jump menu and ⋯ card menu present", async ({ page }) => {
    await addCard(page, "E2E Mobile A", DISCORD_PASTE);
    await saveCard(page, "E2E Mobile A");
    await addCard(page, "E2E Mobile B", "```\n" + "x".repeat(300) + "\n```");
    await saveCard(page, "E2E Mobile B");
    await page.goto("/guild-info");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByLabel("Jump to section")).toBeVisible();
    await expect(page.getByRole("button", { name: "Full width" })).toHaveCount(0); // desktop row hidden
    const menu = page.getByLabel("Actions for E2E Mobile A");
    await menu.click();
    await expect(page.getByRole("button", { name: "Move to top" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Move to bottom" }).first().click();
    await expect(page.locator("section h2").last()).toContainText("E2E Mobile A");

    await deleteCardMobile(page, "E2E Mobile A");
    await deleteCardMobile(page, "E2E Mobile B");
  });
});

async function deleteCardMobile(page: Page, title: string) {
  await page.goto("/guild-info");
  await page.getByLabel(`Actions for ${title}`).click();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: title })).toHaveCount(0);
}

test.describe("item tooltips (admin toggle)", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("off by default → plain text; on → PQDI link with tooltip; off again → plain text", async ({ page }) => {
    await addCard(page, "E2E Items", "Chase the [[Short Sword of the Ykesha]] and a [[Not A Real Quarm Item]].");
    await saveCard(page, "E2E Items");
    const card = page.locator("section", { has: page.getByRole("heading", { name: "E2E Items" }) });

    const resolveCalls: string[] = [];
    page.on("request", (r) => r.url().includes("/api/items/") && resolveCalls.push(r.url()));

    // 1. off (default): plain text, no requests
    await page.goto("/admin");
    const toggle = page.getByRole("switch", { name: "Item tooltips" });
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.goto("/guild-info");
    await expect(card).toContainText("Chase the Short Sword of the Ykesha and a Not A Real Quarm Item.");
    await expect(card.locator("a.pqdi-link")).toHaveCount(0);
    expect(resolveCalls).toHaveLength(0);

    // 2. on: known item links to PQDI, unknown stays text, hover shows the tooltip
    await page.goto("/admin");
    await page.getByRole("switch", { name: "Item tooltips" }).click();
    await expect(page.getByRole("switch", { name: "Item tooltips" })).toHaveAttribute("aria-checked", "true");
    await page.goto("/guild-info");
    const link = card.locator("a.pqdi-link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "https://www.pqdi.cc/item/5500");
    await link.hover();
    const tip = page.locator(".pqdi-tip");
    await expect(tip).toBeVisible();
    // real PQDI content, sanitized and re-pointed at pqdi.cc (needs network)
    await expect(tip).toContainText("Short Sword of the Ykesha");
    await expect(tip).toContainText("Slot: PRIMARY SECONDARY");
    await expect(tip.locator(".pqdi-icon")).toHaveAttribute("style", /https:\/\/www\.pqdi\.cc\/static\/iconss\/dragitem04\.png/);
    await expect(tip.locator("img").first()).toHaveAttribute("src", /^https:\/\/www\.pqdi\.cc\//);
    await expect(tip.locator("[style*='width: 450px'], [onclick]")).toHaveCount(0);
    await expect(tip.locator("script")).toHaveCount(0);

    // 3. back off (leave the site as found)
    await page.goto("/admin");
    await page.getByRole("switch", { name: "Item tooltips" }).click();
    await expect(page.getByRole("switch", { name: "Item tooltips" })).toHaveAttribute("aria-checked", "false");
    await deleteCard(page, "E2E Items");
  });
});

test.describe("item tooltips are admin-only (leader)", () => {
  test.use({ storageState: "e2e/.auth/leader.json" });

  test("a leader sees no Site features switch and cannot reach the tooltip API while it's off", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("switch", { name: "Item tooltips" })).toHaveCount(0);
    const res = await page.request.post("/api/items/resolve", { data: { names: ["Engraved Ring"] } });
    expect(res.status()).toBe(404);
  });
});

test.describe("dashboard time filter (member)", () => {
  test.use({ storageState: "e2e/.auth/member.json" });

  test("defaults to 14 days and remembers the choice", async ({ page, context }) => {
    await context.clearCookies({ name: "dashboard_window" });
    await page.goto("/dashboard");
    const selected = (label: string) => page.getByRole("button", { name: label, exact: true });
    await expect(selected("14 days")).toHaveClass(/bg-neutral-700/);
    await selected("1 month").click();
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === "dashboard_window")?.value).toBe("30d");
    await page.reload();
    await expect(selected("1 month")).toHaveClass(/bg-neutral-700/);
    // put it back
    await selected("14 days").click();
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === "dashboard_window")?.value).toBe("14d");
  });
});
