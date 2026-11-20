import { test, expect } from "@playwright/test";

test("current App: compact headings, case context, bounded resizing and mobile Explorer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/tests/synthetic.html");
  await expect(page.locator("#demo-counts")).toHaveText(
    "4 workspaces · 9 projects · 28 cases · 60 versions",
    { timeout: 90_000 },
  );
  await page
    .getByRole("button", { name: /Return to cAdtree Synthetic Preview v\d+/ })
    .click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree
    .getByRole("treeitem", { name: "Personal SolidWorks", exact: true })
    .click();
  const paneBefore = await page
    .locator(".desktop-workspace-tree")
    .boundingBox();
  await tree
    .getByRole("treeitem", {
      name: "Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  const active = page.locator(".project-context-case");
  await expect(page.getByRole("combobox", { name: "Working case" })).toHaveCount(0);
  const current = page.getByRole("region", { name: "Project context" });
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveText("Case: Main");
  const historyModes = page.locator(".history-page .project-heading-controls");
  // Document coordinates: clicking lower in the page may scroll the window,
  // which must not count as the heading controls moving.
  const documentBox = async () => {
    const box = (await historyModes.boundingBox())!;
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    return { x: box.x + scroll.x, y: box.y + scroll.y };
  };
  const modesBeforeBranchSwitch = await documentBox();
  const filePicker = page.getByRole("combobox", {
    name: "File",
    exact: true,
  });
  expect((await filePicker.boundingBox())!.width).toBeLessThanOrEqual(240);
  await expect(filePicker).toHaveCSS("border-top-style", "solid");
  await expect(filePicker).toHaveCSS("border-top-width", "1px");
  await expect(page.locator(".project-context-name")).toHaveText(
    "Camera Mount",
  );
  await expect(
    page.locator(".workspace-header, .workspace-folder-bar"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reconnect workspace", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Opened managed location/)).toHaveCount(0);
  const graph = page.getByRole("region", {
    name: "Version graph",
    exact: true,
  });
  const contextBox = (await current.boundingBox())!;
  expect((await graph.boundingBox())!.y - contextBox.y - contextBox.height).toBeLessThan(220);
  const paneAfter = await page.locator(".desktop-workspace-tree").boundingBox();
  expect(paneAfter!.y).toEqual(paneBefore!.y);
  expect(paneAfter!.height).toEqual(paneBefore!.height);
  expect(
    (await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .boundingBox())!.y,
  ).toBeGreaterThan(paneAfter!.y + paneAfter!.height);
  await expect(
    tree.getByRole("treeitem", { name: "Personal SolidWorks", exact: true }),
  ).toHaveAccessibleDescription("3 projects");
  await expect(
    tree.getByRole("treeitem", {
      name: "Camera Mount, Personal SolidWorks",
      exact: true,
    }),
  ).toHaveAccessibleDescription("3 cases");
  await expect(
    tree.getByRole("treeitem", {
      name: "Manufacturing alternative, Camera Mount, Personal SolidWorks",
      exact: true,
    }),
  ).toHaveAttribute("title", "Manufacturing alternative");

  // The drawing summary must describe the actual changed document, not a part.
  await expect(
    page
      .getByRole("complementary", { name: "Version details" })
      .locator(".detail-files")
      .getByText("Drawings/Assembly.SLDDRW", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /V4: Explore lighter/ }).click();
  await expect(
    page.getByRole("heading", {
      name: "Explore lighter construction",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manufacturing alternative", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Manufacturing alternative",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await expect(
    tree.getByRole("treeitem", {
      name: "Main, Camera Mount, Personal SolidWorks",
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
  await tree
    .getByRole("treeitem", {
      name: "Lightweight concept, Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(
    tree.getByRole("treeitem", {
      name: "Lightweight concept, Camera Mount, Personal SolidWorks",
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
  const modesAfterBranchSwitch = await documentBox();
  expect(modesAfterBranchSwitch.y).toBe(modesBeforeBranchSwitch.y);
  expect(modesAfterBranchSwitch.x).toBe(modesBeforeBranchSwitch.x);
  await expect(active).toHaveText("Case: Lightweight concept");
  await tree
    .getByRole("treeitem", {
      name: "Main, Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");

  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Changes", exact: true }).click();
  const summary = page.getByRole("textbox", { name: /Version summary/ });
  await summary.fill("Main scoped layout review");
  await tree
    .getByRole("treeitem", {
      name: "Lightweight concept, Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(summary).toHaveValue("");
  await summary.fill("Lightweight scoped layout review");
  await tree
    .getByRole("treeitem", {
      name: "Main, Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(summary).toHaveValue("Main scoped layout review");
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(active).toHaveText("Case: Main");
  await expect(page.getByText("All folders are connected.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect workspace", exact: true }),
  ).toBeHidden();
  await page.locator(".settings-troubleshooting > summary").click();
  await expect(
    page.getByRole("button", { name: "Reconnect workspace", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".settings-page .settings-row", { hasText: "Working folder" }),
  ).toContainText("working/main");
  await nav.getByRole("button", { name: "History", exact: true }).click();

  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.focus();
  await page.keyboard.press("End");
  await expect(resize).toHaveAttribute("aria-valuenow", "400");
  const controls = page.locator(".history-page .project-heading-controls");
  const pickerBox = await current.boundingBox();
  const modesBox = await controls.locator(".segmented").boundingBox();
  expect(
    pickerBox!.x + pickerBox!.width <= modesBox!.x ||
      pickerBox!.y + pickerBox!.height <= modesBox!.y,
  ).toBe(true);
  const grip = (await resize.boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 100);
  await page.mouse.down();
  await page.mouse.move(200, grip.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "240");
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await page
    .getByRole("button", { name: /Return to cAdtree Synthetic Preview v\d+/ })
    .click();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await tree
    .getByRole("treeitem", { name: "Personal SolidWorks", exact: true })
    .click();
  await tree
    .getByRole("treeitem", {
      name: "Camera Mount, Personal SolidWorks",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.screenshot({
    path: "artifacts/screenshots/compact-laptop.png",
    fullPage: false,
  });

  for (const width of [1024, 820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await expect(current).toBeVisible();
    if (width === 1024) {
      await resize.press("End");
      await expect(resize).toHaveAttribute("aria-valuenow", "304");
      expect(
        (await page.locator(".workspace-shell").boundingBox())!.width,
      ).toBeGreaterThanOrEqual(720);
    } else {
      await expect(resize).not.toBeVisible();
      await page
        .getByRole("button", { name: "Browse folders", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Browse folders" });
      await expect(
        dialog.getByRole("tree", { name: "Workspace explorer" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Browse folders", exact: true }),
      ).toBeFocused();
    }
    await page.screenshot({
      path: `artifacts/screenshots/compact-${width}.png`,
      fullPage: false,
    });
  }
  expect(errors).toEqual([]);
});
