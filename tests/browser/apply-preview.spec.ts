import { test, expect } from "@playwright/test";
test("actual App: read-only application preview retains Main's 20 files and requires explicit conflict/deletion decisions on desktop/mobile", async ({
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
  await page
    .getByRole("button", { name: /Return to Synthetic application preview/ })
    .click();
  await page
    .getByRole("textbox", { name: "Cadtree home folder address" })
    .fill("D:\\Synthetic preview");
  await page
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree
    .getByRole("treeitem", { name: "Application preview review", exact: true })
    .click();
  await tree
    .getByRole("treeitem", {
      name: "Actuator preview, Application preview review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const current = page.getByRole("status", { name: "Current branch" });
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await page
    .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
    .click();
  const review = page.getByRole("button", {
    name: "Review changes to apply",
    exact: true,
  });
  await review.click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes to apply — preview",
  });
  const readiness = dialog.getByRole("status", { name: "Preview readiness" });
  const summary = dialog.getByRole("status", {
    name: "Proposed result summary",
  });
  const reason = dialog.getByRole("textbox", {
    name: "Engineering reason for proposed application",
  });
  await expect(
    dialog.getByRole("region", { name: "Base saved revision" }),
  ).toContainText("Rev 001");
  await expect(
    dialog.getByRole("region", { name: "Source saved revision" }),
  ).toContainText("Rev 003");
  await expect(
    dialog.getByRole("region", { name: "Destination saved revision" }),
  ).toContainText("Rev 002");
  await expect(
    dialog.getByText(/Current uncaptured working edits are not included/),
  ).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  const part = "Parts/Part-X.SLDPRT";
  const selection = dialog.getByRole("checkbox", {
    name: `Select source modification: ${part}`,
  });
  await expect(selection).not.toBeChecked();
  await expect(readiness).toContainText("Preview not ready");
  await reason.fill(
    "Reuse the reviewed case Part-X while preserving Main's newer development",
  );
  await selection.check();
  await expect(readiness).toContainText("Ready as a saved-state preview");
  await expect(summary).toContainText("Proposed result: 20 files");
  await expect(summary).toContainText("1 replacements");
  await expect(
    dialog.getByRole("button", { name: "Prepare application" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Apply confirmed changes" }),
  ).toHaveCount(0);
  await dialog
    .getByText("Overall engineering notes · Base, Source and Destination", {
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Source overall notes at Rev 003" }),
  ).toContainText("Overall: Redesign only Part-X");
  await expect(
    dialog.getByRole("region", {
      name: "Destination overall notes at Rev 002",
    }),
  ).toContainText("Overall: Main with 20 files");
  await dialog
    .getByText("Overall engineering notes · Base, Source and Destination", {
      exact: true,
    })
    .click();
  const candidate = dialog.getByRole("article", {
    name: `Source change: ${part}`,
    exact: true,
  });
  await candidate
    .getByText("Saved file states and notes", { exact: true })
    .click();
  await expect(
    candidate.getByRole("region", {
      name: `Source file notes at Rev 003: ${part}`,
    }),
  ).toContainText("Part-X note: Redesign only Part-X");
  await candidate
    .getByText("Saved file states and notes", { exact: true })
    .click();
  await dialog.getByText("Proposed files (20)", { exact: true }).click();
  const files = dialog.locator(".preview-result-files > li");
  await expect(files).toHaveCount(20);
  const paths = await files.locator("strong").allTextContents();
  expect(paths).toEqual(
    fixture.savedFiles[fixture.ids[1]].map((f: { path: string }) => f.path),
  );
  const sourceHash = fixture.savedFiles[fixture.ids[2]].find(
    (f: { path: string }) => f.path === part,
  ).sha256;
  const retainedPath = "Other/Part-X.SLDPRT";
  const retainedHash = fixture.savedFiles[fixture.ids[1]].find(
    (f: { path: string }) => f.path === retainedPath,
  ).sha256;
  await expect(
    files
      .filter({ has: page.getByText(part, { exact: true }) })
      .locator("code"),
  ).toHaveText(sourceHash);
  await expect(
    files
      .filter({ has: page.getByText(retainedPath, { exact: true }) })
      .locator("code"),
  ).toHaveText(retainedHash);
  await expect(
    dialog
      .getByRole("region", { name: "Source changes to review" })
      .getByText(/MainOnly/),
  ).toHaveCount(0);
  await dialog.getByText("Proposed files (20)", { exact: true }).click();
  await dialog
    .getByRole("heading", { name: "Review changes to apply — preview" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/screenshots/apply-preview-desktop.png",
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(review).toBeFocused();
  await expect(
    page.getByRole("button", { name: /Rev 003: Redesign only Part-X/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  // Reopening starts a new ephemeral preview; ordinary Compare remains separate.
  await review.click();
  await expect(selection).not.toBeChecked();
  await expect(reason).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const compareDialog = page.getByRole("dialog", {
    name: "Compare saved revisions",
  });
  await expect(
    compareDialog.getByRole("combobox", { name: "To revision" }),
  ).toHaveValue(fixture.ids[2]);
  await compareDialog
    .getByRole("button", { name: "Close comparison", exact: true })
    .click();
  // Active destination changes only through Explorer, before opening a new preview.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Browse folders", exact: true })
    .click();
  const folder = page.getByRole("dialog", { name: "Browse folders" });
  await folder
    .getByRole("treeitem", {
      name: "Conflict destination, Actuator preview, Application preview review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.conflictDestinationId,
  );
  await page
    .getByRole("button", {
      name: /Rev 005: Source additions, deletion and conflicts/,
    })
    .click();
  await review.click();
  await expect(reason).toHaveValue("");
  await expect(dialog.locator("input[type=checkbox]:checked")).toHaveCount(0);
  await reason.fill(
    "Deliberately reuse reviewed changes and resolve conflicts",
  );
  await dialog
    .getByRole("checkbox", { name: "Select source addition: NewOnly.SLDPRT" })
    .check();
  await expect(readiness).toContainText("Ready as a saved-state preview");
  await dialog
    .getByRole("checkbox", { name: `Select source modification: ${part}` })
    .check();
  const decision = dialog.getByRole("combobox", {
    name: `Conflict decision: ${part}`,
  });
  await expect(decision).toHaveValue("unresolved");
  await expect(readiness).toContainText("Preview not ready");
  await decision.selectOption("keep-destination");
  await expect(readiness).toContainText("Ready as a saved-state preview");
  await decision.selectOption("use-source");
  await expect(summary).toContainText("1 replacements");
  await dialog
    .getByRole("checkbox", { name: "Select source deletion: DeleteMe.SLDPRT" })
    .check();
  const deleteDecision = dialog.getByRole("combobox", {
    name: "Conflict decision: DeleteMe.SLDPRT",
  });
  await expect(
    deleteDecision.getByRole("option", {
      name: "Use source state — DELETE destination file",
      exact: true,
    }),
  ).toHaveCount(1);
  await deleteDecision.selectOption("use-source");
  await expect(summary).toContainText("1 deletions");
  await dialog
    .getByRole("checkbox", {
      name: "Select source modification: ModifiedVsDeleted.SLDPRT",
    })
    .check();
  await dialog
    .getByRole("combobox", {
      name: "Conflict decision: ModifiedVsDeleted.SLDPRT",
    })
    .selectOption("use-source");
  await dialog
    .getByRole("checkbox", { name: "Select source addition: SharedNew.SLDPRT" })
    .check();
  await dialog
    .getByRole("combobox", { name: "Conflict decision: SharedNew.SLDPRT" })
    .selectOption("keep-destination");
  await expect(readiness).toContainText("Ready as a saved-state preview");
  await dialog
    .getByRole("checkbox", { name: "Select source addition: Collision" })
    .check();
  await expect(readiness).toContainText("Preview not ready");
  await expect(
    dialog.getByText("File/directory path collisions", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/apply-preview-mobile-conflicts.png",
    fullPage: false,
  });
  await dialog
    .getByRole("checkbox", { name: "Select source addition: Collision" })
    .uncheck();
  await expect(readiness).toContainText("Ready as a saved-state preview");
  await expect(
    dialog.getByRole("button", { name: "Prepare application" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Apply confirmed changes" }),
  ).toHaveCount(0);
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await dialog
    .getByRole("heading", { name: "Review changes to apply — preview" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/screenshots/apply-preview-mobile.png",
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.conflictDestinationId,
  );
  const after = await page.evaluate(async (name) => {
    const url = "/tests/comparison-seed.ts";
    return (await import(/* @vite-ignore */ url)).comparisonFixtureFingerprint(
      name,
    );
  }, fixture.rootName);
  expect(after).toBe(fixture.fingerprint);
  expect(errors).toEqual([]);
});
