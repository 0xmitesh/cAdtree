import { test, expect } from "@playwright/test";
for (const width of [1366, 390])
  test(`actual App: inspect archived case activity and Compare with Main without writes or context loss at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const fixture = await page.evaluate(async () => {
      const url = "/tests/case-activity-fixture.ts";
      return (await import(/* @vite-ignore */ url)).seedCaseActivityReview();
    });
    await page.reload();
    await page
      .getByRole("button", { name: /Return to Synthetic application preview/ })
      .click();
    await page
      .getByRole("textbox", { name: "Cadtree home folder address" })
      .fill("D:\\Synthetic activity");
    await page
      .getByRole("button", { name: "Complete setup", exact: true })
      .click();
    const tree = page.getByRole("tree", { name: "Workspace explorer" });
    const browse = async () => {
      if (width === 390)
        await page
          .getByRole("button", { name: "Browse folders", exact: true })
          .click();
    };
    await browse();
    await tree
      .getByRole("treeitem", {
        name: "Application preview review",
        exact: true,
      })
      .click();
    await browse();
    await tree
      .getByRole("treeitem", {
        name: "Actuator preview, Application preview review",
        exact: true,
      })
      .click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    const nav = page.getByRole("navigation");
    await nav.getByRole("button", { name: "Changes", exact: true }).click();
    await page
      .getByRole("button", { name: "Scan for changes", exact: true })
      .click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    const summary = page.getByRole("textbox", { name: /Revision summary/ });
    await summary.fill("Main draft stays intact during case review");
    await page
      .getByRole("button", { name: /Add.*overall engineering notes/ })
      .click();
    await page
      .getByRole("textbox", { name: "Overall: observations", exact: true })
      .fill("Overall session draft");
    await page
      .getByRole("button", {
        name: "Add note for Parts/Part-X.SLDPRT",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", {
        name: "Parts/Part-X.SLDPRT: observations",
        exact: true,
      })
      .fill("Part session draft");
    await nav.getByRole("button", { name: "History", exact: true }).click();
    const filePicker = page.getByRole("combobox", {
      name: "File history",
      exact: true,
    });
    await filePicker.selectOption("Parts/Part-X.SLDPRT");
    await page
      .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
      .press("Enter");
    await expect(page.locator(".revision-detail")).toContainText(
      "Redesign only Part-X",
    );
    // No more scans or seed writes after this point. Observe every adapter call
    // during the information/Compare workflow, then compare the entire home fingerprint.
    await page.evaluate(async () => {
      const url = "/tests/case-activity-fixture.ts";
      (await import(/* @vite-ignore */ url)).observeCaseActivityStorage();
    });
    await page.locator('.history-design-cases > summary').click();
    const cases = page.getByRole("region", {
      name: "Design cases",
      exact: true,
    });
    await cases.getByText("Archived cases (1)", { exact: true }).click();
    const disclosure = cases.getByLabel(
      "Saved activity and divergence for Part-X redesign",
      { exact: true },
    );
    await disclosure.focus();
    await disclosure.press("Enter");
    const info = disclosure.locator("..");
    await expect(info).toContainText("Rev 001 · Main");
    await expect(info).toContainText("Rev 003 · Part-X redesign · Archived");
    await expect(info).toContainText("Rev 002 · Main");
    await expect(info).toContainText("Main: 1 revision since shared ancestor");
    await expect(info).toContainText(
      "Case history: 1 revision since shared ancestor",
    );
    await expect(info.locator("time")).toHaveAttribute(
      "datetime",
      fixture.caseSavedAt,
    );
    await expect(
      cases.getByRole("button", {
        name: "Reopen case Part-X redesign",
        exact: true,
      }),
    ).toBeVisible();
    await info.scrollIntoViewIfNeeded();
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/screenshots/case-activity-${width}.png`,
    });
    const compare = info.getByRole("button", {
      name: "Compare Part-X redesign with Main",
      exact: true,
    });
    await compare.focus();
    await compare.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Compare saved revisions",
      exact: true,
    });
    await expect(
      dialog.getByRole("combobox", { name: "From revision" }),
    ).toHaveValue(fixture.ids[2]);
    await expect(
      dialog.getByRole("combobox", { name: "To revision" }),
    ).toHaveValue(fixture.ids[1]);
    await expect(dialog).toContainText("Scope: All project files");
    await expect(dialog).toContainText("Part-X redesign · Archived");
    await expect(
      dialog.getByRole("region", {
        name: "From overall notes at Rev 003",
        exact: true,
      }),
    ).toContainText("Overall: Redesign only Part-X");
    await expect(
      dialog.getByRole("region", {
        name: "To overall notes at Rev 002",
        exact: true,
      }),
    ).toContainText("Overall: Main with 20 files");
    await page.screenshot({
      path: `artifacts/screenshots/case-activity-compare-${width}.png`,
    });
    await dialog
      .getByRole("button", { name: "Close comparison", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(compare).toBeFocused();
    await expect(
      page.getByRole("status", { name: "Current branch", exact: true }),
    ).toHaveAttribute("data-branch-id", "branch-main");
    const calls = await page.evaluate(async () => {
      const url = "/tests/case-activity-fixture.ts";
      return (
        await import(/* @vite-ignore */ url)
      ).finishCaseActivityObservation();
    });
    expect(calls).toEqual({});
    await nav.getByRole("button", { name: "History", exact: true }).click();
    await expect(filePicker).toHaveValue("Parts/Part-X.SLDPRT");
    await expect(page.locator(".revision-detail")).toContainText(
      "Redesign only Part-X",
    );
    await expect(
      page.getByRole("status", { name: "Current branch" }),
    ).toHaveAttribute("data-branch-id", "branch-main");
    await nav.getByRole("button", { name: "Changes", exact: true }).click();
    await expect(summary).toHaveValue(
      "Main draft stays intact during case review",
    );
    await expect(
      page.getByRole("textbox", { name: "Overall: observations", exact: true }),
    ).toHaveValue("Overall session draft");
    await expect(
      page.getByRole("textbox", {
        name: "Parts/Part-X.SLDPRT: observations",
        exact: true,
      }),
    ).toHaveValue("Part session draft");
    const after = await page.evaluate(async (rootName) => {
      const url = "/tests/comparison-seed.ts";
      return (
        await import(/* @vite-ignore */ url)
      ).comparisonFixtureFingerprint(rootName);
    }, fixture.rootName);
    expect(after).toBe(fixture.fingerprint);
    expect(errors).toEqual([]);
  });
