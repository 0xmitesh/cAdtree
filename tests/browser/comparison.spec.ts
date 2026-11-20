import { pickFile, fileInput } from "./file-picker";
import { test, expect } from "@playwright/test";

test("actual App: arbitrary saved comparisons, scoped history, Swap and read-only 5-to-20 snapshots on desktop/mobile", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/comparison-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedComparisonReview();
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Return to Synthetic comparison/ })
    .click();
  await page
    .getByRole("textbox", { name: "Cadtree home folder address" })
    .fill("D:\\Synthetic comparisons");
  await page
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree
    .getByRole("treeitem", { name: "Comparison review", exact: true })
    .click();
  await tree
    .getByRole("treeitem", {
      name: "Snapshot comparison, Comparison review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const current = page.getByRole("region", { name: "Project context" });
  const file = fileInput(page);
  const compare = page.getByRole("button", { name: "Compare", exact: true });
  const dialog = page.getByRole("dialog", { name: "Compare saved versions" });
  const from = dialog.getByRole("combobox", { name: "From version" });
  const to = dialog.getByRole("combobox", { name: "To version" });
  const counts = dialog.getByRole("status", { name: "Comparison counts" });
  const expectCounts = async (
    added: number,
    deleted: number,
    modified: number,
    unchanged: number,
  ) =>
    expect(counts.locator("span")).toHaveText([
      `${added} added`,
      `${deleted} deleted`,
      `${modified} modified`,
      `${unchanged} unchanged`,
    ]);
  await compare.click();
  await expect(from).toHaveValue(fixture.ids[1]);
  await expect(to).toHaveValue(fixture.ids[3]);
  await expect(from).toBeFocused();
  await expectCounts(16, 2, 1, 3);
  // Nonadjacent Main snapshots do not need a direct parent relationship.
  await from.selectOption(fixture.ids[0]);
  await expectCounts(17, 2, 1, 2);
  // A five-file saved case versus the twenty-file current Main snapshot.
  await from.selectOption(fixture.ids[2]);
  await expect(from).toHaveAttribute(
    "title",
    /V3 · Old design case · Old case with 5 files/,
  );
  await expect(to).toHaveAttribute(
    "title",
    /V4 · Main · Main release with 20 files/,
  );
  await expectCounts(17, 2, 1, 2);
  await expect(
    dialog.getByRole("region", { name: "From overall notes at V3" }),
  ).toContainText("Old case with 5 files");
  await expect(
    dialog.getByRole("region", { name: "To overall notes at V4" }),
  ).toContainText("Main release with 20 files");
  await expect(dialog.getByText(/5 files · Records checked/)).toBeVisible();
  await expect(dialog.getByText(/20 files · Records checked/)).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/comparison-desktop.png",
    fullPage: false,
  });
  const pin = dialog.getByRole("article", {
    name: "Modified: Parts/Pin.SLDPRT",
    exact: true,
  });
  await expect(pin.getByText("Case-pin note", { exact: true })).toBeVisible();
  await expect(
    pin.getByText("Main-release pin note", { exact: true }),
  ).toBeVisible();
  await expect(pin.getByText("File notes at V3")).toBeVisible();
  await expect(pin.getByText("File notes at V4")).toBeVisible();
  const beforeSizes = await pin
    .locator(".comparison-file-endpoints section > p")
    .allTextContents();
  await dialog.getByRole("button", { name: "Swap", exact: true }).click();
  await expectCounts(2, 17, 1, 2);
  await expect(
    dialog.getByRole("region", { name: "From overall notes at V4" }),
  ).toContainText("Main release with 20 files");
  await expect(
    dialog.getByRole("region", { name: "To overall notes at V3" }),
  ).toContainText("Old case with 5 files");
  await expect(
    pin.locator(".comparison-file-endpoints section > p"),
  ).toHaveText([...beforeSizes].reverse());
  await dialog.getByRole("button", { name: "Swap", exact: true }).click();
  await expectCounts(17, 2, 1, 2);
  await dialog.getByText(/Project directory changes \(/).click();
  await expect(
    dialog.getByText("Added · Empty new/", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Added · Empty new/Empty nested/", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Deleted · Empty original/", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("article", {
      name: "Deleted: Retired/Legacy.SLDPRT",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Show 2 unchanged files" }).click();
  await expect(
    dialog.getByRole("article", {
      name: "Unchanged: Other/Pin.SLDPRT",
      exact: true,
    }),
  ).toBeVisible();
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await page.screenshot({
    path: "artifacts/screenshots/comparison-details.png",
    fullPage: false,
  });
  // Same revision is a valid comparison with zero differences.
  await from.selectOption(fixture.ids[3]);
  await expectCounts(0, 0, 0, 20);
  await expect(
    dialog.getByText(
      "No file or folder differences between these versions.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(compare).toBeFocused();
  await expect(page.getByRole("button", { name: /V4:/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // A selected historical file narrows initial scope, without changing graph/list inspection.
  await pickFile(page, "Parts/Pin.SLDPRT");
  await page.getByRole("button", { name: /V2:/ }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await compare.click();
  await expect(from).toHaveValue(fixture.ids[0]);
  await expect(to).toHaveValue(fixture.ids[1]);
  await expect(
    dialog.getByRole("group", { name: "Comparison scope" }),
  ).toContainText("Parts/Pin.SLDPRT");
  await expectCounts(0, 0, 1, 0);
  await dialog
    .getByRole("button", { name: "Show all files", exact: true })
    .click();
  await expectCounts(1, 0, 1, 4);
  await dialog
    .getByRole("button", { name: "Focus on selected file", exact: true })
    .click();
  await expectCounts(0, 0, 1, 0);
  await dialog.getByRole("button", { name: "Close comparison" }).click();
  await expect(file).toHaveValue("Parts/Pin.SLDPRT");
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".revision-list-row.selected")).toContainText(
    "V2",
  );
  // A path absent in both selected snapshots is explained, not hidden.
  await pickFile(page, "MainOnly/Part01.SLDPRT");
  await compare.click();
  await from.selectOption(fixture.ids[0]);
  await to.selectOption(fixture.ids[2]);
  await expect(
    dialog.getByText("The selected path is absent in both versions."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close comparison" }).click();
  // Inspect and compare on a case without switching working context through the dialog.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Browse folders", exact: true })
    .click();
  const folders = page.getByRole("dialog", { name: "Browse folders" });
  await folders
    .getByRole("treeitem", {
      name: "Old design case, Snapshot comparison, Comparison review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.alternativeId,
  );
  await pickFile(page, "Parts/Pin.SLDPRT");
  await compare.click();
  await from.selectOption(fixture.ids[2]);
  await to.selectOption(fixture.ids[3]);
  await expectCounts(0, 0, 1, 0);
  await expect(
    dialog.getByRole("region", { name: "From overall notes at V3" }),
  ).toContainText("Old case with 5 files");
  await expect(
    dialog.getByRole("region", { name: "To overall notes at V4" }),
  ).toContainText("Main release with 20 files");
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/comparison-mobile.png",
    fullPage: false,
  });
  await dialog
    .getByRole("button", { name: "Show all files", exact: true })
    .click();
  await expectCounts(17, 2, 1, 2);
  await dialog.getByRole("button", { name: "Swap", exact: true }).click();
  await expectCounts(2, 17, 1, 2);
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.alternativeId,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The entire managed home, including both working folders and stored records,
  // is byte-for-byte the same after every comparison interaction.
  const after = await page.evaluate(async (name) => {
    const url = "/tests/comparison-seed.ts";
    return (await import(/* @vite-ignore */ url)).comparisonFixtureFingerprint(
      name,
    );
  }, fixture.rootName);
  expect(after).toBe(fixture.fingerprint);
  expect(errors).toEqual([]);
});
