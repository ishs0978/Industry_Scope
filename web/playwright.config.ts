import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-driven accessibility checks. The rest of the suite is vitest in a
 * node environment, which is why web/lib/a11y.test.ts has to read component
 * source text rather than a rendered page; this config is what lets the
 * accessibility tree be inspected for real.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.IS_BASE_URL ?? "http://127.0.0.1:3210",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
