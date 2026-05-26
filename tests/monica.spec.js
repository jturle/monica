// Playwright test: drive monica's CDP endpoint to open example.com, then close it.
//
// monica must be running locally (yarn start). The ?session= below labels the
// pane in monica's tab strip — closing the page (or the connection) removes it.
//
// Setup (one-time):
//   yarn add -D @playwright/test
//   # we connect over CDP so we don't need Playwright's bundled browsers:
//   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 yarn install
//
// Run:
//   npx playwright test tests/monica.spec.js --reporter=list

const { test, expect, chromium } = require("@playwright/test");

const CDP_ENDPOINT = "http://127.0.0.1:9222?session=playwright-demo";

test("opens example.com in monica then closes the page", async () => {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];      // the default (and only) context
  const page = await context.newPage();        // → opens a pane in monica
  try {
    await page.goto("https://example.com");
    await expect(page).toHaveTitle(/Example Domain/);
  } finally {
    await page.close();                        // Target.closeTarget → pane removed
    await browser.close();                     // disconnects the CDP connection
  }
});
