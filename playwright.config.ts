import { defineConfig } from "@playwright/test";
const port = process.env.CADTREE_TEST_PORT ?? "2500";
export default defineConfig({
  testDir: "./tests/browser",
  use: {
    channel: process.env.CADTREE_BROWSER_CHANNEL,
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port=${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    env: {
      ...process.env,
      CADTREE_TEST_AUTH: "1",
    },
  },
  reporter: "list",
});
