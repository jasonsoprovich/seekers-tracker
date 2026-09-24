import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [320, 375, 390, 768, 1440];

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string) {
  const parse = (value: string) => {
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${value}`);
    return 0.2126 * channel(channels[0]) + 0.7152 * channel(channels[1]) + 0.0722 * channel(channels[2]);
  };
  const a = parse(foreground);
  const b = parse(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function captureSignInDestination(page: Page, click: () => Promise<void>) {
  const requestPromise = page.waitForRequest((request) => request.url().includes("/api/auth/sign-in/social"));
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "E2E stop" }) }),
  );
  await click();
  const request = await requestPromise;
  return request.postDataJSON() as { callbackURL?: string };
}

for (const width of WIDTHS) {
  test(`landing page has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page.getByRole("heading", { level: 1, name: "Good souls leave a lasting mark." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "The Player Quest Board" })).toBeVisible();
  });
}

test("landing hero uses the optimized guild image within its payload budget", async ({ page }) => {
  const imageResponse = page.waitForResponse((response) => response.url().includes("seekers-banner.webp"));
  await page.goto("/");
  const response = await imageResponse;
  const payload = await response.body();
  expect(payload.byteLength).toBeLessThan(300_000);

  const heroImage = page.getByAltText(/members gathered before a glowing norrath portal/i);
  await expect(heroImage).toBeVisible();
  expect(await heroImage.getAttribute("fetchpriority")).toBe("high");
  const frame = await heroImage.locator("..").boundingBox();
  expect((frame?.width ?? 0) / (frame?.height ?? 1)).toBeCloseTo(2 / 3, 2);
});

test("landing page records a good local LCP", async ({ page }) => {
  await page.addInitScript(() => {
    const measurements = window as Window & { __seekersLcp?: number };
    measurements.__seekersLcp = 0;
    new PerformanceObserver((list) => {
      const latest = list.getEntries().at(-1);
      if (latest) measurements.__seekersLcp = latest.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const lcp = await page.evaluate(() => (window as Window & { __seekersLcp?: number }).__seekersLcp ?? 0);
  expect(lcp).toBeGreaterThan(0);
  expect(lcp).toBeLessThanOrEqual(2_500);
});

test("landing page has a keyboard-visible skip path", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to guild information" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#guild-story$/);
});

test("landing header actions are keyboard reachable with visible focus", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Seekers of Souls home" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Join our Discord" }).first()).toBeFocused();
  await page.keyboard.press("Tab");
  const signIn = page.getByRole("button", { name: "Member sign in" });
  await expect(signIn).toBeFocused();
  expect(await signIn.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
});

test("public motion is disabled when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const animations = await page.evaluate(() => {
    const hero = document.querySelector("section[aria-labelledby='hero-heading']");
    const image = document.querySelector("figure img")?.parentElement;
    return {
      orbit: hero ? getComputedStyle(hero, "::after").animationName : null,
      image: image ? getComputedStyle(image).animationName : null,
    };
  });
  expect(animations).toEqual({ orbit: "none", image: "none" });
});

test("primary public text and actions meet WCAG AA contrast", async ({ page }) => {
  await page.goto("/");
  const colors = await page.evaluate(() => {
    const heroHeading = document.querySelector("h1")!;
    const primaryAction = Array.from(document.querySelectorAll("a")).find(
      (element) => element.textContent?.includes("Join our Discord") && getComputedStyle(element).color === "rgb(17, 19, 7)",
    )!;
    const questHeading = Array.from(document.querySelectorAll("h2")).find((element) =>
      element.textContent?.includes("Player Quest Board"),
    )!;
    return {
      hero: [getComputedStyle(heroHeading).color, "rgb(9, 11, 7)"],
      action: [getComputedStyle(primaryAction).color, "rgb(184, 144, 60)"],
      quest: [getComputedStyle(questHeading).color, getComputedStyle(questHeading.parentElement!).backgroundColor],
    };
  });
  expect(contrastRatio(colors.hero[0], colors.hero[1])).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.action[0], colors.action[1])).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.quest[0], colors.quest[1])).toBeGreaterThanOrEqual(4.5);
});

test("landing page starts Discord sign-in directly", async ({ page }) => {
  await page.goto("/");
  const body = await captureSignInDestination(page, () =>
    page.getByRole("button", { name: "Member sign in" }).click(),
  );
  expect(body.callbackURL).toBe("/characters");
});

test("login preserves safe internal destinations and rejects external ones", async ({ page }) => {
  await page.goto("/login?next=%2Fepgp%2Fledger%3Ftype%3Dbids");
  const internal = await captureSignInDestination(page, () =>
    page.getByRole("button", { name: "Sign in with Discord" }).click(),
  );
  expect(internal.callbackURL).toBe("/epgp/ledger?type=bids");

  await page.unroute("**/api/auth/sign-in/social");
  await page.goto("/login?next=https%3A%2F%2Fevil.example%2Fsteal");
  const external = await captureSignInDestination(page, () =>
    page.getByRole("button", { name: "Sign in with Discord" }).click(),
  );
  expect(external.callbackURL).toBe("/characters");
});

test("protected routes send unauthenticated visitors back through login", async ({ page }) => {
  await page.goto("/epgp/ledger?type=bids");
  await expect(page).toHaveURL(/\/login\?next=%2Fepgp%2Fledger%3Ftype%3Dbids$/);
});

test.describe("already signed in", () => {
  // 2026-09-23 post-live-test-1 feedback: clicking "Member sign in" on the
  // homepage, or landing on /login directly, always forced a fresh Discord
  // OAuth round trip even when the visitor's session was still good — see
  // DiscordSignInButton's own comment. Both should now skip Discord
  // entirely and go straight to where the member was headed.
  test.use({ storageState: "e2e/.auth/member.json" });

  test("homepage sign-in button skips Discord and goes straight in", async ({ page }) => {
    let hitDiscordSignIn = false;
    await page.route("**/api/auth/sign-in/social", (route) => {
      hitDiscordSignIn = true;
      return route.continue();
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Member sign in" }).click();
    await expect(page).toHaveURL(/\/characters$/);
    expect(hitDiscordSignIn).toBe(false);
  });

  test("/login redirects an already signed-in visitor to their destination", async ({ page }) => {
    await page.goto("/login?next=%2Froster");
    await expect(page).toHaveURL(/\/roster$/);
  });
});
