import { test, expect } from "@playwright/test";
test("actual App: file history follows parents across branches, retains deleted paths, and preserves working context", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const url = "/tests/file-history-seed.ts";
    return (await import(/* @vite-ignore */ url)).seedFileHistoryReview();
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Return to Synthetic file history/ })
    .click();
  await page
    .getByRole("textbox", { name: "Cadtree home folder address" })
    .fill("D:\\Synthetic");
  await page
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  const tree = page.getByRole("tree", { name: "Workspace explorer" });
  await tree
    .getByRole("treeitem", { name: "File history review", exact: true })
    .click();
  await tree
    .getByRole("treeitem", {
      name: "Synthetic actuator, File history review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const current = page.getByRole("status", { name: "Current branch" });
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  const file = page.getByRole("combobox", {
    name: "File history",
    exact: true,
  });
  await expect(file).toHaveValue("");
  await expect(page.locator(".graph-row")).toHaveCount(14);
  await expect(file.locator("option")).toContainText([
    "All files",
    "AlternativeOnly.txt",
    "Obsolete/Retired.SLDPRT",
    "Other/Pin.SLDPRT",
    "Parts/Pin.SLDPRT",
  ]);
  await file.selectOption("Parts/Pin.SLDPRT");
  await expect(
    page.locator('.graph-row[data-file-history-kind="change"]'),
  ).toHaveCount(7);
  await expect(
    page.locator('.graph-row[data-file-history-kind="context"]'),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Rev 011:/ })).toHaveCount(0);
  // Ten initial Main snapshots contain exactly four file change events.
  const firstTen = await page
    .locator('.graph-row[data-file-history-kind="change"] .graph-hit')
    .evaluateAll(
      (buttons) =>
        buttons.filter(
          (b) =>
            Number(b.getAttribute("aria-label")!.match(/Rev (\d+)/)![1]) <= 10,
        ).length,
    );
  expect(firstTen).toBe(4);
  await page.getByRole("button", { name: /Rev 008:/ }).click();
  await expect(
    page.getByRole("region", { name: "Selected file history" }),
  ).toContainText("Modified");
  await expect(
    page.getByRole("region", { name: "Selected file history" }),
  ).toContainText("Project step 8");
  await page.getByRole("button", { name: "Alternative", exact: true }).click();
  await expect(
    page.locator('.graph-row[data-file-history-kind="change"]'),
  ).toHaveCount(2);
  await expect(page.locator("path[data-child]")).toHaveCount(2);
  await expect(
    page.locator(`path[data-child="${fixture.ids[11]}"]`),
  ).toHaveAttribute("data-parent", fixture.ids[1]);
  await page.getByRole("button", { name: /Rev 002:/ }).click();
  await expect(
    page.getByRole("region", { name: "Selected file history" }),
  ).toContainText("Context only");
  await expect(current).toHaveAttribute("data-branch-id", "branch-main");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".revision-list-row")).toHaveCount(3);
  await file.selectOption("AlternativeOnly.txt");
  await page.getByRole("button", { name: "Main", exact: true }).click();
  await expect(
    page.getByText(/No recorded history for this file within Main/),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Revision details" }),
  ).toHaveCount(0);
  await file.selectOption("");
  await expect(page.locator(".revision-list-row")).toHaveCount(14);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await file.selectOption("Obsolete/Retired.SLDPRT");
  await expect(
    page.locator('.graph-row[data-file-history-kind="change"]'),
  ).toHaveCount(2);
  await page.getByRole("button", { name: /Rev 002:/ }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Select Obsolete/Retired.SLDPRT for recovery",
    }),
  ).toBeDisabled();
  await file.selectOption("Parts/Pin.SLDPRT");
  await page.getByRole("button", { name: /Rev 013:/ }).click();
  await expect(
    page.getByRole("region", { name: "Selected file history" }),
  ).toContainText("Deleted");
  await page.getByRole("button", { name: /View in parent revision/ }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Select Parts/Pin.SLDPRT for recovery",
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Copy selected files (1)" }).click();
  await expect(
    page.getByRole("dialog", { name: "Copy selected files" }),
  ).toContainText("Rev 010");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Show all branches", exact: true })
    .click();
  await page.getByRole("button", { name: /Rev 014:/ }).click();
  await expect(
    page.getByRole("region", { name: "Selected file history" }),
  ).toContainText("Reintroduced");
  // Actual branch switches still originate from Explorer, never history controls.
  await tree
    .getByRole("treeitem", {
      name: "Alternative, Synthetic actuator, File history review",
      exact: true,
    })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.alternativeId,
  );
  await file.selectOption("Parts/Pin.SLDPRT");
  await page.getByRole("button", { name: /Rev 001:/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /Rev 002:/ })).toBeFocused();
  await expect(current).toHaveAttribute(
    "data-branch-id",
    fixture.alternativeId,
  );
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.focus();
  await page.keyboard.press("End");
  await expect(resize).toHaveAttribute("aria-valuenow", "400");
  for (const width of [1366, 1024, 820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await expect(file).toBeVisible();
    await expect(
      page.getByRole("button", { name: "List", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `artifacts/screenshots/file-history-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await tree
    .getByRole("treeitem", {
      name: "Second synthetic project, File history review",
      exact: true,
    })
    .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History", exact: true })
    .click();
  await expect(file).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Your design history starts here" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
