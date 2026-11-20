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
const EDIT = "UNCAPTURED WORKING EDIT — preview must neither read nor replace this as saved state";

test("actual App: Discard puts an edited file back and keeps the edit in Discarded/<date time>/", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 844 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/apply-preview-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
  });
  await page.reload();
  await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
  await page.getByRole("textbox", { name: "Cadtree home folder address" }).fill("D:\\Synthetic application");
  await page.getByRole("button", { name: "Complete setup", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree.getByRole("treeitem", { name: "Application preview review", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Actuator preview, Application preview review", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("navigation").getByRole("button", { name: "Changes", exact: true }).click();
  await waitForScan(page);
  expect(await fixtureCall(page, fixture, "readDiscardedCopies")).toEqual({});

  await page.getByLabel("File actions — Parts/Part-X.SLDPRT").click();
  await page.getByRole("button", { name: "Discard — Parts/Part-X.SLDPRT" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard this change" });
  await expect(dialog.getByRole("status", { name: "What will change" })).toContainText("1 change will be discarded");
  await expect(dialog.getByRole("region", { name: "Put back to the saved version" })).toContainText("Parts/Part-X.SLDPRT");
  await expect(dialog.getByTestId("discard-copy-line")).toContainText(/A copy of your edits will be kept in Discarded\/\d{4}-\d\d-\d\d \d\d\.\d\d/);
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Discarded 1 change\. A copy is in Discarded\/\d{4}-\d\d-\d\d \d\d\.\d\d\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy folder path", exact: true })).toBeVisible();
  await expect(page.getByText(/No changes since/)).toBeVisible({ timeout: 15_000 });

  const copies = (await fixtureCall(page, fixture, "readDiscardedCopies")) as Record<string, Record<string, string>>;
  const names = Object.keys(copies);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d\.\d\d$/);
  expect(copies[names[0]]["Parts/Part-X.SLDPRT"]).toBe(EDIT);
  expect(Object.keys(copies[names[0]])).toContain("_DISCARDED cAdtree.txt");
  const after = (await fixtureCall(page, fixture, "readApplicationFixture")) as {
    main: { files: { path: string }[] };
  };
  expect(after.main.files.map((f) => f.path)).toContain("Parts/Part-X.SLDPRT");
  expect(errors).toEqual([]);
});
