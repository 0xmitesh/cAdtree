import { expect, test } from "@playwright/test";
import path from "node:path";

// Run only in an environment where local browser inspection is permitted.
// All project data here is synthetic and confined to the dev-only preview entry.
const screenshotDir =
  process.env.CADTREE_SCREENSHOT_DIR ?? "artifacts/screenshots";
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`workspace selection and notes at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/tests/preview.html");
    await expect(page.getByRole("heading", { name: "History." })).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, `history-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: /Rev 002: Refine/ }).click();
    await expect(
      page.getByRole("heading", { name: "Refine housing clearance" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Refine housing clearance" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByRole("button", { name: /Rev 002: Refine/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("heading", {
        name: "Add bearing retainer and update drawing",
      }),
    ).toBeVisible();
    const mainWidth = await page
      .locator("body")
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(mainWidth.scroll).toBeLessThanOrEqual(mainWidth.client + 1);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Changes", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: /Revision summary/ })
      .fill("Refine housing clearance");
    await page
      .getByRole("button", { name: "Add note for Parts/Housing.SLDPRT" })
      .click();
    await page
      .getByRole("textbox", { name: "Parts/Housing.SLDPRT: problem" })
      .fill("Shaft binds at operating temperature.");
    await page.screenshot({
      path: path.join(screenshotDir, `changes-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Changes", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Parts/Housing.SLDPRT: problem" }),
    ).toHaveValue("Shaft binds at operating temperature.");
  });
}
for (const scenario of ["empty", "single", "branches", "long", "damaged"]) {
  test(`history scenario: ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/tests/preview.html?scenario=" + scenario);
    if (scenario === "empty")
      await expect(
        page.getByRole("heading", { name: "Your design history starts here" }),
      ).toBeVisible();
    if (scenario === "branches") {
      await page
        .getByRole("button", { name: "Prototype", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Prototype", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    if (scenario === "long") {
      const latest = page.getByRole("button", { name: /Rev 120:/ });
      await latest.focus();
      await page.keyboard.press("Home");
      await expect(
        page.getByRole("heading", {
          name: "Initial assembly and component set",
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await expect(latest).toHaveAttribute("aria-pressed", "true");
    }
    if (scenario === "damaged")
      await expect(
        page.getByText("History needs attention.", { exact: true }),
      ).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir, `scenario-${scenario}.png`),
      fullPage: true,
    });
  });
}
test("export for review dialog keyboard focus", async ({ page }) => {
  await page.goto("/tests/preview.html?scenario=single");
  const trigger = page.getByRole("button", {
    name: "Export for review",
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Export revision for review" }),
  ).toContainText("Complete project");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
