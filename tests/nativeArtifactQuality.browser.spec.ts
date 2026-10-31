import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installHostedWidgetFixtures,
  WIDGET_FIXTURE_ORIGIN,
} from "./hostedWidgetFixtures";
import nativeResponse from "./fixtures/nativeArtifactReview.private.json";
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
});
describe.each(["light", "dark"] as const)(
  "native quality on a 390px %s phone",
  (theme) => {
    it("renders the canonical native grade and recorded checks without a legacy score formula", async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await installHostedWidgetFixtures(page);
      await page.addInitScript(
        ({ theme, response }) => {
          (window as unknown as Record<string, unknown>).openai = {
            theme,
            toolOutput: response,
            setWidgetHeight() {},
          };
        },
        { theme, response: nativeResponse }
      );
      try {
        await page.goto(
          `${WIDGET_FIXTURE_ORIGIN}/widgets/artifact-review.html?anatomy=expanded`
        );
        await page.locator("[data-quality-anatomy]").waitFor();
        expect(await page.locator("body").innerText()).toContain(
          "Judged lower bound = 96"
        );
        expect(await page.locator(".qv-check").first().innerText()).toContain(
          "Links resolve"
        );
        expect(await page.locator("body").innerText()).not.toContain(
          "Average of"
        );
        expect(await page.locator('a[href*="eval-runs"]').count()).toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth)
        ).toBeLessThanOrEqual(390);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: `/tmp/mcp-native-quality-${theme}.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }, 30000);
  }
);
