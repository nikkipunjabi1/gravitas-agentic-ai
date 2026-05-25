import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — Phase 0 smoke.
 *
 * One project (chromium desktop). One test: /copilot loads, "debug" produces
 * a canvas action. CI: starts `pnpm dev` and tears it down. Local: reuses an
 * already-running dev server.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false, // single project, single browser — no benefit to parallel
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    // Run on a less-trafficked port so a developer's own `pnpm dev` on :3000
    // doesn't collide with the e2e webServer. Override via PLAYWRIGHT_BASE_URL.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec next dev -p 3010",
    url: "http://localhost:3010",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
