import { waitForScan } from "./rescan";
import { test, expect, type Page } from "@playwright/test";

const fixtureCall = (page: Page, fixture: unknown, step: string) =>
  page.evaluate(
    async ({ fixture, step }) => {
      const url = "/tests/application-fixture.ts";
      return (await import(/* @vite-ignore */ url))[step](fixture);
    },
    { fixture, step },
  );

test("actual App: Get this version puts one older file into the working folder as an unsaved change", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 844 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/apply-preview-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
  });
  await fixtureCall(page, fixture, "cleanFixtureMain");
  await page.reload();
  await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
  await page.getByRole("textbox", { name: "Cadtree home folder address" }).fill("D:\\Synthetic application");
  await page.getByRole("button", { name: "Complete setup", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree.getByRole("treeitem", { name: "Application preview review", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Actuator preview, Application preview review", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const nav = (name: string) =>
    page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  await nav("Changes");
  await waitForScan(page);
  await nav("History");
  // Main's latest (Rev 002) changed Other/Part-X.SLDPRT; get the Rev 001 version back.
  await page.getByRole("button", { name: /V1: Base with 5 files/ }).press("Enter");
  const row = page.locator(".detail-file").filter({ hasText: "Other/Part-X.SLDPRT" });
  await row.getByRole("button", { name: "Get this version", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Get this version" });
  await expect(dialog).toContainText(
    "Put Other/Part-X.SLDPRT from V1 into your working folder? It will show as an unsaved change.",
  );
  await expect(dialog).not.toContainText("current edits");
  await dialog.getByRole("button", { name: "Get this version", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.getByText(
      /^V1 of Other\/Part-X\.SLDPRT is in your working folder\. Save to keep it, or Discard to undo\./,
    ),
  ).toBeVisible();
  const after = await fixtureCall(page, fixture, "readApplicationFixture");
  const old = fixture.savedFiles[fixture.ids[0]].find(
    (f: { path: string }) => f.path === "Other/Part-X.SLDPRT",
  );
  expect(
    after.main.files.find((f: { path: string }) => f.path === "Other/Part-X.SLDPRT").sha256,
  ).toBe(old.sha256);
  expect(after.state.applicationOperations).toHaveLength(1);
  expect(after.state.applicationOperations[0].status).toBe("done");
  expect(after.state.applicationOperations[0].record.plan.mode).toBe("restore-file");
  expect(after.state.revisions).toHaveLength(fixture.ids.length);
  // The automatic rescan shows it as an unsaved change.
  await nav("Changes");
  await expect(page.getByText("Other/Part-X.SLDPRT").first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
