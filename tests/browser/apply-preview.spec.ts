import { test, expect } from "@playwright/test";
test("actual App: the Copy files dialog lists only the case's changes, needs a choice for each file changed in both, and writes nothing until Copy files (desktop/mobile)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/apply-preview-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
  });
  await page.reload();
  await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
  await page.getByRole("textbox", { name: "Cadtree home folder address" }).fill("D:\\Synthetic preview");
  await page.getByRole("button", { name: "Complete setup", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree.getByRole("treeitem", { name: "Application preview review", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Actuator preview, Application preview review", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const current = page.getByRole("region", { name: "Project context" });
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await page.getByRole("button", { name: /V3: Redesign only Part-X/ }).click();
  const open = page.getByRole("button", { name: "Copy files from Part-X redesign…", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Copy files from Part-X redesign" });
  const part = "Parts/Part-X.SLDPRT";
  // Only the file the case changed is listed, ticked; Main's own files are not.
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox", { name: `Copy ${part}` })).toBeChecked();
  await expect(dialog.getByText(/MainOnly/)).toHaveCount(0);
  await expect(dialog).not.toContainText(/Base|Destination|Prepare|Engineering reason/);
  await expect(dialog.getByRole("textbox", { name: "Why (optional)" })).toHaveValue("");
  await page.screenshot({ path: "artifacts/screenshots/apply-preview-desktop.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByRole("button", { name: /V3: Redesign only Part-X/ })).toHaveAttribute("aria-pressed", "true");
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  // Ordinary Compare stays separate.
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const compareDialog = page.getByRole("dialog", { name: "Compare saved versions" });
  await expect(compareDialog.getByRole("combobox", { name: "To version" })).toHaveValue(fixture.ids[2]);
  await compareDialog.getByRole("button", { name: "Close comparison", exact: true }).click();
  // The active case changes only through the Explorer, before opening a new dialog.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Browse folders", exact: true }).click();
  const folder = page.getByRole("dialog", { name: "Browse folders" });
  await folder
    .getByRole("treeitem", { name: "Conflict destination, Actuator preview, Application preview review", exact: true })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(current).toHaveAttribute("data-branch-id", fixture.conflictDestinationId);
  await page.getByRole("button", { name: /V5: Source additions, deletion and conflicts/ }).click();
  await page.getByRole("button", { name: "Copy files from Conflicting source…", exact: true }).click();
  const conflicts = page.getByRole("dialog", { name: "Copy files from Conflicting source" });
  const copy = conflicts.getByRole("button", { name: "Copy files", exact: true });
  await expect(conflicts.getByRole("checkbox", { name: "Copy NewOnly.SLDPRT" })).toBeChecked();
  for (const path of [part, "DeleteMe.SLDPRT", "ModifiedVsDeleted.SLDPRT"]) {
    const group = conflicts.getByRole("group", { name: `Changed in both: ${path}` });
    await expect(group.getByRole("radio", { name: "Keep mine" })).not.toBeChecked();
    await expect(group.getByRole("radio", { name: /^Take theirs/ })).not.toBeChecked();
  }
  await expect(
    conflicts.getByRole("group", { name: "Changed in both: DeleteMe.SLDPRT" }).getByRole("radio", { name: "Take theirs (removes the file)" }),
  ).toHaveCount(1);
  await expect(conflicts.getByRole("status", { name: "Changed in both" })).toContainText("3 files were changed in both");
  // Added independently on both sides: different component identities, so greyed (identity is never guessed).
  await expect(conflicts.getByRole("listitem", { name: "Can't copy: SharedNew.SLDPRT" })).toContainText("Renamed in one case; can't copy yet.");
  await expect(copy).toBeDisabled();
  await conflicts.getByRole("group", { name: `Changed in both: ${part}` }).getByRole("radio", { name: "Take theirs" }).check();
  await conflicts.getByRole("group", { name: "Changed in both: DeleteMe.SLDPRT" }).getByRole("radio", { name: /^Take theirs/ }).check();
  await conflicts.getByRole("group", { name: "Changed in both: ModifiedVsDeleted.SLDPRT" }).getByRole("radio", { name: "Keep mine" }).check();
  // A file the case added where this case has a folder clashes until it is unticked.
  await expect(conflicts.getByText("These paths clash", { exact: true })).toBeVisible();
  await expect(copy).toBeDisabled();
  await page.screenshot({ path: "artifacts/screenshots/apply-preview-mobile-conflicts.png", fullPage: false });
  await conflicts.getByRole("checkbox", { name: "Copy Collision" }).uncheck();
  await expect(conflicts.getByText("These paths clash", { exact: true })).toHaveCount(0);
  await expect(copy).toBeEnabled();
  expect(await conflicts.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/screenshots/apply-preview-mobile.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(current).toHaveAttribute("data-branch-id", fixture.conflictDestinationId);
  const after = await page.evaluate(async (name) => {
    const url = "/tests/comparison-seed.ts";
    return (await import(/* @vite-ignore */ url)).comparisonFixtureFingerprint(name);
  }, fixture.rootName);
  expect(after).toBe(fixture.fingerprint);
  expect(errors).toEqual([]);
});
