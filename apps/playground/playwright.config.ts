import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm --prefix ../.. run dev --workspace=@quanby/ticketing-mock-api",
      url: "http://127.0.0.1:4010/api/v1/tickets",
      reuseExistingServer: !process.env.CI,
      env: {
        TICKETING_CLIENT_ID: "playground",
        TICKETING_CLIENT_SECRET: "playground-secret-that-is-at-least-32-bytes",
        MOCK_API_CORS_ORIGIN: "http://127.0.0.1:3100",
      },
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      env: {
        TICKETING_API_URL: "http://127.0.0.1:4010/api/v1",
        TICKETING_CLIENT_ID: "playground",
        TICKETING_CLIENT_SECRET: "playground-secret-that-is-at-least-32-bytes",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
