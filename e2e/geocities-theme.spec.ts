import { expect, test, type Page } from "@playwright/test";

// The joke GeoCities skin is presentation-only, off by default, and toggled by
// the Konami code. These tests pin that contract.
test.use({ storageState: "e2e/.auth/leader.json" });

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

async function konami(page: Page) {
  for (const key of KONAMI) await page.keyboard.press(key);
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test("is off by default and Konami toggles it on and off", async ({ page }) => {
  await page.goto("/roster");
  await page.locator("main").waitFor();
  expect(await theme(page)).toBeNull();

  await konami(page);
  await expect.poll(() => theme(page)).toBe("geocities");
  expect(await page.evaluate(() => localStorage.getItem("seekers-geocities"))).toBe("on");

  await konami(page);
  await expect.poll(() => theme(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("seekers-geocities"))).toBeNull();
});

test("preference survives a reload and the exit button turns it off", async ({ page }) => {
  await page.goto("/roster");
  await page.locator("main").waitFor();
  await konami(page);
  await expect.poll(() => theme(page)).toBe("geocities");

  await page.reload();
  await expect.poll(() => theme(page)).toBe("geocities");

  await page.getByRole("button", { name: "Exit 1997 mode" }).click();
  await expect.poll(() => theme(page)).toBeNull();
  await page.reload();
  expect(await theme(page)).toBeNull();
});

test("typing the code inside a text field does not toggle it", async ({ page }) => {
  await page.goto("/roster");
  const search = page.locator("main input[type='search'], main input[type='text']").first();
  await search.click();
  await konami(page);
  expect(await theme(page)).toBeNull();
});

test("themed pages keep working and do not overflow", async ({ page }) => {
  await page.goto("/roster");
  await page.locator("main").waitFor();
  await konami(page);
  await expect.poll(() => theme(page)).toBe("geocities");
  for (const width of [390, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth, `overflow at ${width}px`).toBeLessThanOrEqual(dims.clientWidth);
  }
  // Real controls stay clickable (decor is pointer-events: none).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Bank" }).first().click();
  await expect(page).toHaveURL(/\/bank/);
});

test("login page is never themed", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("seekers-geocities", "on"));
  await page.goto("/login");
  expect(await theme(page)).toBeNull();
  await ctx.close();
});
