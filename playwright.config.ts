import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/browser.spec.ts",
  use: {
    channel: "msedge",
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
  },
  timeout: 30000,
  reporter: "list",
  outputDir: "work/playwright-results",
});
