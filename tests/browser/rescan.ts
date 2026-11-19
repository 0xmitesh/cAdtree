import { expect, type Page } from "@playwright/test";

/**
 * Returns to the window the way a user does and waits for the quiet automatic rescan to show a newer result.
 * Replaces clicking the removed "Scan for changes" button.
 */
export async function waitForScan(page: Page) {
  const stamp = () =>
    page.evaluate(
      () => document.querySelector("[data-scanned-at]")?.getAttribute("data-scanned-at") ?? null,
    );
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const before = await stamp();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(stamp, { timeout: 15_000 }).not.toBe(before);
  await expect(page.getByTestId("auto-check")).toHaveCount(0);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
}
