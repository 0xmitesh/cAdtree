import { waitForScan } from "./rescan";
import { pickFile } from "./file-picker";
import { test, expect } from "@playwright/test";
for (const width of [1366, 390])
  test(`actual App: hide, discover, inspect, reload and unhide a case at ${width}px`, async ({
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
    const readOnce = () =>
      page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        return (await import(/* @vite-ignore */ url)).readLifecycleFixture(
          fixture,
        );
      }, fixture);
    // The offline guide is refreshed in the background after hide/unhide; a read
    // that meets its temporary .crswap file is retried once the write settles.
    const read = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await readOnce();
        } catch (error) {
          if (attempt >= 5 || !String(error).includes(".crswap")) throw error;
          await page.waitForTimeout(250);
        }
      }
    };
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
    // The Explorer is the only case switcher: the sidebar tree on wide screens, "Browse folders" on narrow ones.
    const select = {
      selectOption: async (branchId: string) => {
        const row = page.locator(`[role="treeitem"][data-branch-id="${branchId}"]:visible`);
        if (!(await row.count()))
          await nav.getByRole("button", { name: "Browse folders", exact: true }).click();
        await row.click();
      },
    };
    const hideButton = page.getByRole("button", {
      name: "Hide case Part-X redesign",
      exact: true,
    });
    if (width === 1366) {
      await settings();
      await select.selectOption(fixture.safeCaseId);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await showCases();
      // The working case can be hidden; the dialog says the app switches to Main.
      await hideButton.click();
      const current = page.getByRole("dialog", {
        name: "Hide design case",
        exact: true,
      });
      await expect(current).toContainText(
        "You are working on this case. cAdtree switches you to Main after hiding it.",
      );
      await current.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(current).toHaveCount(0);
      await page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        await (
          await import(/* @vite-ignore */ url)
        ).lifecycleDraftEdit(fixture);
      }, fixture);
      await nav.getByRole("button", { name: "Changes", exact: true }).click();
      await waitForScan(page);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await page
        .getByRole("textbox", { name: /Version summary/ })
        .fill("Keep this case-scoped engineering draft");
      await page
        .getByRole("button", { name: /Add a description/ })
        .click();
      await page
        .getByRole("textbox", { name: "Overall: Description", exact: true })
        .fill("Session draft survives lifecycle metadata changes");
      await page
        .getByRole("button", {
          name: "Add note for Parts/Part-X.SLDPRT",
          exact: true,
        })
        .click();
      await page
        .getByRole("textbox", {
          name: "Parts/Part-X.SLDPRT: Note",
          exact: true,
        })
        .fill("Retain this per-file draft too");
      await page.evaluate(async (fixture) => {
        const url = "/tests/case-lifecycle-fixture.ts";
        await (
          await import(/* @vite-ignore */ url)
        ).lifecycleDraftEdit(fixture, true);
      }, fixture);
      await waitForScan(page);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await select.selectOption("branch-main");
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    }
    await showCases();
    const hide = async () => {
      await hideButton.click();
      const modal = page.getByRole("dialog", {
        name: "Hide design case",
        exact: true,
      });
      await expect(modal).toContainText(
        "Its folder and saved versions stay in place",
      );
      await modal
        .getByRole("button", { name: "Hide case", exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Design cases", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByText("1 hidden case. Turn on Show hidden cases to see it.", {
          exact: true,
        }),
      ).toBeVisible();
    };
    const showHiddenCases = async () => {
      await page.locator(".history-hidden-toggle input").check();
    };
    const unhide = async () => {
      await showHiddenCases();
      await page
        .getByRole("button", {
          name: "Unhide case Part-X redesign",
          exact: true,
        })
        .click();
      const modal = page.getByRole("dialog", {
        name: "Unhide design case",
        exact: true,
      });
      await modal
        .getByRole("button", { name: "Unhide", exact: true })
        .click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Project context"})).toHaveAttribute('data-branch-id', 'branch-main');
    };
    await hide();
    await expect(page.getByRole("region", { name: "Project context"})).toHaveAttribute('data-branch-id', 'branch-main');
    await expect(
      page.locator(`[role="treeitem"][data-branch-id="${fixture.safeCaseId}"]`),
    ).toHaveCount(0);
    if (width === 1366) {
      await unhide();
      await settings();
      await select.selectOption(fixture.safeCaseId);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await nav.getByRole("button", { name: "Changes", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: /Version summary/ }),
      ).toHaveValue("Keep this case-scoped engineering draft");
      await expect(
        page.getByRole("textbox", {
          name: "Overall: Description",
          exact: true,
        }),
      ).toHaveValue("Session draft survives lifecycle metadata changes");
      await expect(
        page.getByRole("textbox", {
          name: "Parts/Part-X.SLDPRT: Note",
          exact: true,
        }),
      ).toHaveValue("Retain this per-file draft too");
      await select.selectOption("branch-main");
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await showCases();
      await hide();
    }
    const archived = await read();
    expect(archived.unchangedFingerprint).toBe(before.unchangedFingerprint);
    expect(archived.state.caseLifecycles[fixture.safeCaseId].status).toBe(
      "archived",
    );
    expect(archived.state.branches).toEqual(before.state.branches);
    expect(archived.state.revisions).toEqual(before.state.revisions);
    await browse();
    await page.locator(".tree-hidden-toggle input:visible").check();
    const archivedNode = tree.getByRole("treeitem", {
      name: "Part-X redesign · Hidden, Actuator preview, Application preview review",
      exact: true,
    });
    await expect(archivedNode).toHaveAttribute("aria-disabled", "true");
    if (width === 390)
      await page
        .getByRole("dialog", { name: "Browse folders" })
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
    await showHiddenCases();
    await expect(
      page.getByRole("button", {
        name: "Unhide case Part-X redesign",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/screenshots/case-hidden-${width}.png`,
    });
    await nav.getByRole("button", { name: "History", exact: true }).click();
    await page
      .getByRole("button", { name: /V3: Redesign only Part-X/ })
      .press("Enter");
    await expect(page.locator(".detail-meta")).toContainText(
      "Part-X redesign · Hidden",
    );
    await expect(
      page.getByRole("button", {
        name: "Part-X redesign · Hidden",
        exact: true,
      }),
    ).toBeVisible();
    await pickFile(page, "Parts/Part-X.SLDPRT");
    await page
      .getByRole("button", { name: /V3: Redesign only Part-X/ })
      .press("Enter");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const compare = page.getByRole("dialog", {
      name: "Compare saved versions",
    });
    await expect(compare).toBeVisible();
    await expect(
      compare.getByRole("region", { name: "To overall notes at V3" }),
    ).toContainText("Overall: Redesign only Part-X");
    await compare
      .getByRole("button", { name: "Close comparison", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Copy files from Part-X redesign · Hidden…", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Copy files from Part-X redesign · Hidden",
    });
    await expect(review.getByRole("checkbox", { name: "Copy Parts/Part-X.SLDPRT" })).toBeChecked();
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
    await unhide();
    const after = await read();
    expect(after.unchangedFingerprint).toBe(before.unchangedFingerprint);
    expect(after.state.caseLifecycles[fixture.safeCaseId].status).toBe(
      "active",
    );
    expect(after.state.branches).toEqual(before.state.branches);
    expect(after.state.revisions).toEqual(before.state.revisions);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `artifacts/screenshots/case-unhidden-${width}.png`,
    });
  });
