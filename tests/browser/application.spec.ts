import { waitForScan } from "./rescan";
import { test, expect, type Page } from "@playwright/test";

const readFixture = (page: Page, fixture: unknown) =>
  page.evaluate(async (fixture) => {
    const url = "/tests/application-fixture.ts";
    return (await import(/* @vite-ignore */ url)).readApplicationFixture(fixture);
  }, fixture);
const fixtureStep = (page: Page, fixture: unknown, step: string) =>
  page.evaluate(
    async ({ fixture, step }) => {
      const url = "/tests/application-fixture.ts";
      await (await import(/* @vite-ignore */ url))[step](fixture);
    },
    { fixture, step },
  );
const why = "Reuse reviewed Part-X while retaining all newer Main development";

async function setUp(page: Page, width: number, clean = false) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/apply-preview-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
  });
  if (clean) await fixtureStep(page, fixture, "cleanFixtureMain");
  await page.reload();
  await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
  await page.getByRole("textbox", { name: "Cadtree home folder address" }).fill("D:\\Synthetic application");
  await page.getByRole("button", { name: "Complete setup", exact: true }).click();
  const openProject = async () => {
    if (width === 390) await page.getByRole("button", { name: "Browse folders", exact: true }).click();
    const tree = page.getByRole("tree", { name: "Workspace explorer" });
    await tree.getByRole("treeitem", { name: "Application preview review", exact: true }).click();
    if (width === 390) await page.getByRole("button", { name: "Browse folders", exact: true }).click();
    await tree.getByRole("treeitem", { name: "Actuator preview, Application preview review", exact: true }).click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  };
  await openProject();
  const nav = (name: string) =>
    page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
  const openCopy = async () => {
    await nav("History");
    await page.getByRole("button", { name: /V3: Redesign only Part-X/ }).press("Enter");
    await page.getByRole("button", { name: "Copy files from Part-X redesign…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Copy files from Part-X redesign" });
    await expect(dialog.getByRole("checkbox", { name: "Copy Parts/Part-X.SLDPRT" })).toBeChecked();
    await dialog.getByRole("textbox", { name: "Why (optional)" }).fill(why);
    return dialog;
  };
  return { fixture, openProject, openCopy, nav };
}

for (const width of [1366, 390])
  test(`actual App: Copy files saves automatically, keeps provenance and unrelated files, waits for unsaved changes, and Bring back saves too at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { fixture, openProject, openCopy, nav } = await setUp(page, width);
    const before = await readFixture(page, fixture);
    // The seed leaves an unsaved edit in Main: the dialog offers Save my changes first.
    await nav("Changes");
    await waitForScan(page);
    let dialog = await openCopy();
    await expect(dialog).toContainText(/Main has \d+ unsaved changes?\./);
    await expect(dialog.getByRole("button", { name: "Copy files", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save my changes first", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /Version summary/ })).toBeVisible();
    const unchanged = await readFixture(page, fixture);
    expect(unchanged.main).toEqual(before.main);
    expect(unchanged.state.applicationOperations).toEqual([]);
    await fixtureStep(page, fixture, "cleanFixtureMain");
    await waitForScan(page);
    dialog = await openCopy();
    await expect(dialog).not.toContainText(/Base|Destination|Prepare/);
    const copy = dialog.getByRole("button", { name: "Copy files", exact: true });
    await expect(copy).toBeEnabled();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/screenshots/application-copy-${width}.png` });
    await copy.click();
    // Writing and saving runs under one lock and can take a while on a loaded machine.
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    // Main's previous head (the Undo target) is Rev 002: Rev 003 to 005 belong to the case.
    await expect(page.getByText("Saved as V6. To undo, bring back V2.")).toBeVisible();
    // Undo opens Bring back for Rev 002 in History; Cancel writes nothing.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const undoDialog = page.getByRole("dialog", { name: "Bring back V2 onto Main" });
    await expect(undoDialog.getByRole("status", { name: "What will change" })).toHaveText("1 file will change");
    await undoDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(undoDialog).toHaveCount(0);
    const saved = await readFixture(page, fixture);
    expect(saved.source).toBe(before.source);
    expect(saved.main.files).toHaveLength(20);
    const baseline = fixture.savedFiles[fixture.ids[1]];
    for (const file of saved.main.files)
      expect(file.sha256).toBe(
        file.path === "Parts/Part-X.SLDPRT"
          ? fixture.savedFiles[fixture.ids[2]].find((f: { path: string }) => f.path === file.path).sha256
          : baseline.find((f: { path: string }) => f.path === file.path).sha256,
      );
    const revision = saved.state.revisions.find(
      (r: { manifest: { displayNumber: number } }) => r.manifest.displayNumber === 6,
    )!;
    expect(revision.manifest.summary).toBe("Copied 1 file from Part-X redesign");
    expect(revision.manifest.parentRevisionId).toBe(fixture.ids[1]);
    expect(revision.manifest.files).toHaveLength(20);
    expect(revision.manifest.notes.problem).toBe(why);
    expect(saved.state.applicationOperations).toHaveLength(1);
    expect(saved.state.applicationOperations[0].status).toBe("captured");
    expect(saved.state.applicationOperations[0].capturedRevisionId).toBe(revision.manifest.revisionId);
    await page.reload();
    await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await openProject();
    await expect(page.getByRole("region", { name: "Bring back, Copy or Discard status" })).toHaveCount(0);
    await nav("History");
    await page.getByRole("button", { name: /V6: Copied 1 file from Part-X redesign/ }).press("Enter");
    await expect(page.getByText(/^Copied from V3 on Part-X redesign/)).toBeVisible();
    await page.locator(".revision-troubleshooting > summary").click();
    await expect(page.getByText("Saved files match what you chose", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Project context" })).toHaveAttribute("data-branch-id", "branch-main");
    await page.locator(".applied-from-details").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/screenshots/application-provenance-${width}.png` });
    // Bring back Rev 002 onto Main: one dialog, an optional Why, saved automatically.
    await page.getByRole("button", { name: /V2:/ }).press("Enter");
    await page.getByRole("button", { name: "Bring back onto Main…", exact: true }).click();
    const bringBack = page.getByRole("dialog", { name: "Bring back V2 onto Main" });
    await expect(bringBack.getByRole("region", { name: "Replaced with the older version" })).toContainText("Parts/Part-X.SLDPRT");
    await bringBack.getByRole("button", { name: "Bring back", exact: true }).click();
    await expect(bringBack).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("Saved as V7. To undo, bring back V6.")).toBeVisible();
    const broughtBack = await readFixture(page, fixture);
    for (const file of broughtBack.main.files)
      expect(file.sha256).toBe(baseline.find((f: { path: string }) => f.path === file.path).sha256);
    const rev7 = broughtBack.state.revisions.find(
      (r: { manifest: { displayNumber: number } }) => r.manifest.displayNumber === 7,
    )!;
    expect(rev7.manifest.summary).toBe("Brought back V2");
    expect(rev7.manifest.notes.problem).toBe("");
    expect(errors).toEqual([]);
  });

test("actual App: an interrupted Copy survives reload and Undo the unfinished Copy preserves unexpected later edits", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { fixture, openProject, openCopy } = await setUp(page, 390, true);
  const dialog = await openCopy();
  await fixtureStep(page, fixture, "failNextFixtureWorkingAcknowledgement");
  await dialog.getByRole("button", { name: "Copy files", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "acknowledgement lost" })).toBeVisible();
  await page.keyboard.press("Escape");
  const status = page.getByRole("region", { name: "Bring back, Copy or Discard status" });
  await expect(status).toContainText("A Copy was interrupted");
  await page.reload();
  await page.getByRole("button", { name: /Return to Synthetic application preview/ }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  if (!(await status.isVisible())) await openProject();
  await expect(status).toContainText("Saving and another Bring back, Copy or Discard are blocked");
  await fixtureStep(page, fixture, "adjustFixtureMain");
  await status.getByRole("button", { name: "Undo the unfinished Copy", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "Undo the unfinished Copy" });
  await recovery.getByRole("checkbox", { name: "I have saved and closed these files in my CAD program." }).check();
  const undo = recovery.getByRole("button", { name: "Undo the unfinished Copy", exact: true });
  await undo.click();
  await expect(recovery.getByRole("alert")).toContainText("Manual recovery required: Parts/Part-X.SLDPRT");
  expect(await recovery.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/screenshots/application-recovery-mobile.png" });
  const retained = await readFixture(page, fixture);
  expect(retained.state.applicationOperations[0].status).toBe("unresolved");
  expect(retained.state.revisions).toHaveLength(5);
  expect(
    retained.main.files.find((f: { path: string }) => f.path === "Parts/Part-X.SLDPRT").sha256,
  ).not.toBe(
    fixture.savedFiles[fixture.ids[2]].find((f: { path: string }) => f.path === "Parts/Part-X.SLDPRT").sha256,
  );
  // Simulate an engineer manually restoring the verified before-state, then verify the undo.
  await fixtureStep(page, fixture, "cleanFixtureMain");
  await undo.click();
  await expect(recovery).toHaveCount(0);
  await expect(status).toHaveCount(0);
  const recovered = await readFixture(page, fixture);
  expect(recovered.state.applicationOperations[0].status).toBe("recovered");
  expect(recovered.state.revisions).toHaveLength(5);
  expect(recovered.main.files).toHaveLength(20);
});
