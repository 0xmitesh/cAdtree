import { test, expect } from "@playwright/test";
for (const width of [1366, 390])
  test(`actual App: archive, discover, inspect, reload and reopen a case at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const fixture = await page.evaluate(async () => {
      const url = "/tests/apply-preview-seed.ts";
      return (await import(/* @vite-ignore */ url)).seedApplyPreviewReview();
    });
    const read = () =>
      page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        return (await import(/* @vite-ignore */ url)).readLifecycleFixture(
          fixture,
        );
      }, fixture);
    const before = await read();
    await page.reload();
    await page
      .getByRole("button", { name: /Return to Synthetic application preview/ })
      .click();
    await page
      .getByRole("textbox", { name: "Cadtree home folder address" })
      .fill("D:\\Synthetic lifecycle");
    await page
      .getByRole("button", { name: "Complete setup", exact: true })
      .click();
    const browse = async () => {
      if (width === 390)
        await page
          .getByRole("button", { name: "Browse folders", exact: true })
          .click();
    };
    const tree = page.getByRole("tree", { name: "Workspace explorer" });
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
    const settings = () =>
      nav.getByRole("button", { name: "Settings", exact: true }).click();
    const showCases = async () => {
      await nav.getByRole('button', { name: 'History', exact: true }).click();
      if (await page.locator('.history-design-cases').getAttribute('open') === null)
        await page.locator('.history-design-cases > summary').click();
    };
    const select = page.getByRole("combobox", {
      name: "Working case",
      exact: true,
    });
    const archiveButton = page.getByRole("button", {
      name: "Archive case Part-X redesign",
      exact: true,
    });
    if (width === 1366) {
      await settings();
      await select.selectOption(fixture.safeCaseId);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await showCases();
      await expect(archiveButton).toBeDisabled();
      await expect(
        page.getByText("Switch to another working case before archiving.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        await (
          await import(/* @vite-ignore */ url)
        ).lifecycleDraftEdit(fixture);
      }, fixture);
      await nav.getByRole("button", { name: "Changes", exact: true }).click();
      await page
        .getByRole("button", { name: "Scan for changes", exact: true })
        .click();
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await page
        .getByRole("textbox", { name: /Revision summary/ })
        .fill("Keep this case-scoped engineering draft");
      await page
        .getByRole("button", { name: /Add.*overall engineering notes/ })
        .click();
      await page
        .getByRole("textbox", { name: "Overall: observations", exact: true })
        .fill("Session draft survives lifecycle metadata changes");
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
        .fill("Retain this per-file draft too");
      await page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        await (
          await import(/* @vite-ignore */ url)
        ).lifecycleDraftEdit(fixture, true);
      }, fixture);
      await page
        .getByRole("button", { name: "Scan for changes", exact: true })
        .click();
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await select.selectOption("branch-main");
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    }
    await showCases();
    const archive = async () => {
      await archiveButton.click();
      const modal = page.getByRole("dialog", {
        name: "Archive design case",
        exact: true,
      });
      await expect(modal).toContainText("In-app drafts remain intact");
      await modal
        .getByRole("button", { name: "Archive case", exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(
        page.getByText("Archived cases (1)", { exact: true }),
      ).toBeFocused();
    };
    const showArchivedCases = async () => {
      if (
        (await page
          .locator(".case-archive-disclosure")
          .getAttribute("open")) === null
      )
        await page.getByText("Archived cases (1)", { exact: true }).click();
    };
    const reopen = async () => {
      await showArchivedCases();
      await page
        .getByRole("button", {
          name: "Reopen case Part-X redesign",
          exact: true,
        })
        .click();
      const modal = page.getByRole("dialog", {
        name: "Reopen design case",
        exact: true,
      });
      await modal
        .getByRole("button", { name: "Reopen case", exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Project context"})).toHaveAttribute('data-branch-id', 'branch-main');
    };
    await archive();
    await expect(page.getByRole("region", { name: "Project context"})).toHaveAttribute('data-branch-id', 'branch-main');
    await expect(
      page.locator(`.settings-page option[value="${fixture.safeCaseId}"]`),
    ).toHaveCount(0);
    if (width === 1366) {
      await reopen();
      await settings();
      await select.selectOption(fixture.safeCaseId);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await nav.getByRole("button", { name: "Changes", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: /Revision summary/ }),
      ).toHaveValue("Keep this case-scoped engineering draft");
      await expect(
        page.getByRole("textbox", {
          name: "Overall: observations",
          exact: true,
        }),
      ).toHaveValue("Session draft survives lifecycle metadata changes");
      await expect(
        page.getByRole("textbox", {
          name: "Parts/Part-X.SLDPRT: observations",
          exact: true,
        }),
      ).toHaveValue("Retain this per-file draft too");
      await select.selectOption("branch-main");
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await showCases();
      await archive();
    }
    const archived = await read();
    expect(archived.unchangedFingerprint).toBe(before.unchangedFingerprint);
    expect(archived.state.caseLifecycles[fixture.safeCaseId].status).toBe(
      "archived",
    );
    expect(archived.state.branches).toEqual(before.state.branches);
    expect(archived.state.revisions).toEqual(before.state.revisions);
    await browse();
    await page
      .getByRole("checkbox", { name: "Show archived cases", exact: true })
      .check();
    const archivedNode = tree.getByRole("treeitem", {
      name: "Part-X redesign · Archived, Actuator preview, Application preview review",
      exact: true,
    });
    await expect(archivedNode).toHaveAttribute("aria-disabled", "true");
    if (width === 390)
      await page
        .getByRole("dialog", { name: "Browse folders" })
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
    await showArchivedCases();
    await expect(
      page.getByRole("button", {
        name: "Reopen case Part-X redesign",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/screenshots/case-archive-${width}.png`,
    });
    await nav.getByRole("button", { name: "History", exact: true }).click();
    await page
      .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
      .press("Enter");
    await expect(page.locator(".detail-meta")).toContainText(
      "Part-X redesign · Archived",
    );
    await expect(
      page.getByRole("button", {
        name: "Part-X redesign · Archived",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "File history", exact: true })
      .selectOption("Parts/Part-X.SLDPRT");
    await page
      .getByRole("button", { name: /Rev 003: Redesign only Part-X/ })
      .press("Enter");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const compare = page.getByRole("dialog", {
      name: "Compare saved revisions",
    });
    await expect(compare).toBeVisible();
    await expect(
      compare.getByRole("region", { name: "To overall notes at Rev 003" }),
    ).toContainText("Overall: Redesign only Part-X");
    await compare
      .getByRole("button", { name: "Close comparison", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review changes to apply", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review changes to apply — preview",
    });
    await expect(
      review.getByRole("region", { name: "Source saved revision" }),
    ).toContainText("Part-X redesign · Archived");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("region", { name: "Project context" }),
    ).toHaveAttribute("data-branch-id", "branch-main");
    await page.reload();
    await page
      .getByRole("button", { name: /Return to Synthetic application preview/ })
      .click();
    await expect(
      page.getByRole("button", {
        name: /Return to Synthetic application preview/,
      }),
    ).toHaveCount(0);
    // Use explicit project navigation if reconnection restores only the home overview.
    if (
      !(await nav
        .getByRole("button", { name: "Settings", exact: true })
        .isVisible())
    ) {
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
    }
    await showCases();
    await reopen();
    const after = await read();
    expect(after.unchangedFingerprint).toBe(before.unchangedFingerprint);
    expect(after.state.caseLifecycles[fixture.safeCaseId].status).toBe(
      "active",
    );
    expect(after.state.branches).toEqual(before.state.branches);
    expect(after.state.revisions).toEqual(before.state.revisions);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `artifacts/screenshots/case-reopened-${width}.png`,
    });
  });
