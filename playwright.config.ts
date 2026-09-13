import { defineConfig, devices } from "@playwright/test";

// Phase 6 task 6.7 — this project's first browser test suite (everything
// else here is scripts/verify-*.ts against local D1 directly, or manual
// browser click-through, per CLAUDE.md's own testing conventions). Runs
// against `next dev` (initOpenNextCloudflareForDev() in next.config.ts
// already gives it local D1 access) rather than the full opennextjs-
// cloudflare preview build — these tests exercise page/component
// responsiveness and accessibility, not anything Durable-Object-backed.
export default defineConfig({
  testDir: "./e2e",
  // Serial, not parallel: the webServer is a plain `next dev` (needed for
  // local D1 bindings — see next.config.ts), which compiles each route on
  // demand. Several workers cold-hitting different routes at once was
  // observed to make next dev's on-demand compiler choke and abort
  // in-flight requests, producing test failures unrelated to the app.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
