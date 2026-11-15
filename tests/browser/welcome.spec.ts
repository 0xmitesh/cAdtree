import { test, expect } from "@playwright/test";

for (const width of [1366, 390]) {
  test(`actual App: a welcoming first visit and a returning home at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const title = page.getByRole("heading", {
      name: "Welcome to cAdtree",
      exact: true,
    });
    await expect(title).toBeVisible();
    await expect(page.getByText("Home options", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Switch Cadtree home", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Inspect external workspaces",
        exact: true,
      }),
    ).toHaveCount(0);
    const start = page.getByRole("button", {
      name: "Start my Cadtree home",
      exact: true,
    });
    const open = page.getByRole("button", {
      name: "Open my Cadtree home",
      exact: true,
    });
    await expect(start).toBeEnabled();
    await expect(open).toBeEnabled();
    // The rail caption is hidden on narrow screens on purpose (index.css).
    if (width >= 1000)
      await expect(
        page.getByRole("complementary").getByText("Your files. Your storage.", {
          exact: true,
        }),
      ).toBeVisible();
    expect(
      await start.evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBeLessThan(844);
    expect(
      await page
        .locator("body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/screenshots/welcome-first-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(() => {
      Object.assign(window, {
        showDirectoryPicker: async () => {
          throw new DOMException("The user aborted a request.", "AbortError");
        },
      });
    });
    const contentBeforeWarning = await page.locator(".welcome-paths").boundingBox();
    await start.click();
    const cancelled = page.getByRole("alert");
    await expect(cancelled).toHaveCount(1);
    await expect(cancelled).toHaveClass(/error/);
    await expect(cancelled).toContainText("Choose an empty dedicated folder");
    const noticeBounds = (await cancelled.boundingBox())!;
    const labelBounds = (await page.locator(".compact-local-indicator").boundingBox())!;
    const mainBounds = (await page.getByRole("main").boundingBox())!;
    expect(noticeBounds.y).toBeGreaterThan(labelBounds.y + labelBounds.height + 8);
    expect(Math.abs(noticeBounds.x + noticeBounds.width / 2 - (mainBounds.x + mainBounds.width / 2))).toBeLessThan(1);
    expect(Math.abs(noticeBounds.y + noticeBounds.height / 2 - 844 / 2)).toBeLessThan(1);
    expect(noticeBounds.width).toBeLessThanOrEqual(680);
    expect(await page.locator(".welcome-paths").boundingBox()).toEqual(contentBeforeWarning);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cancelled).toHaveCSS("color", "rgb(155, 61, 46)");
    await page.screenshot({
      path: `artifacts/screenshots/welcome-centred-warning-${width}.png`,
      fullPage: false,
    });
    const dismiss = cancelled.getByRole("button", { name: "Dismiss message" });
    await dismiss.focus();
    await dismiss.press("Enter");
    await expect(cancelled).toHaveCount(0);
    expect(await page.locator(".welcome-paths").boundingBox()).toEqual(contentBeforeWarning);
    const rootName = await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      const name = `Welcome home ${crypto.randomUUID()}`;
      const root = await storage.getDirectoryHandle(name, { create: true });
      Object.assign(window, {
        welcomeRoot: root,
        welcomePickerCalls: 0,
        showDirectoryPicker: async () => {
          (window as any).welcomePickerCalls++;
          return root;
        },
      });
      return name;
    });
    const entries = () =>
      page.evaluate(async () => {
        const names: string[] = [];
        for await (const name of (window as any).welcomeRoot.keys())
          names.push(name);
        return names;
      });
    expect(await entries()).toEqual([]);
    // Reject a populated new-home folder once, without changing its files.
    await page.evaluate(async () => {
      const root = (window as any).welcomeRoot as FileSystemDirectoryHandle;
      const file = await root.getFileHandle("Existing-part.SLDPRT", { create: true });
      const writer = await file.createWritable();
      await writer.write("disposable synthetic CAD bytes");
      await writer.close();
    });
    await start.click();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText("Choose an empty dedicated folder");
    expect(await entries()).toEqual(["Existing-part.SLDPRT"]);
    await page.screenshot({
      path: `artifacts/screenshots/welcome-single-warning-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(async () => {
      const root = (window as any).welcomeRoot as FileSystemDirectoryHandle;
      await root.removeEntry("Existing-part.SLDPRT");
    });
    // Both existing native picker routes stay distinct; opening an empty folder
    // reports the existing error rather than silently creating a home.
    await open.click();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await entries()).toEqual([]);
    await start.focus();
    await start.press("Enter");
    const setup = page.getByRole("dialog", {
      name: "Complete home setup",
      exact: true,
    });
    await expect(setup).toBeVisible();
    expect(await page.evaluate(() => (window as any).welcomePickerCalls)).toBe(
      3,
    );
    await setup.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(title).toBeVisible();
    expect(await entries()).toEqual([]);
    await expect(page.getByText("Home options", { exact: true })).toHaveCount(
      0,
    );
    await start.click();
    await setup
      .getByRole("textbox", {
        name: "Cadtree home folder address",
        exact: true,
      })
      .fill("D:\\Cadtree");
    await setup
      .getByRole("button", { name: "Complete setup", exact: true })
      .click();
    await expect(setup).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create workspace", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("Home options", { exact: true })).toBeVisible();
    await expect(title).toHaveCount(0);
    const logo = page.getByRole("button", {
      name: "cAdtree introduction",
      exact: true,
    });
    const workspaces = page
      .getByRole("navigation")
      .getByRole("button", { name: "My workspaces", exact: true });
    const pickerCalls = await page.evaluate(
      () => (window as any).welcomePickerCalls,
    );
    await logo.click();
    await expect(title).toBeVisible();
    await expect(logo).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Home options", { exact: true })).toHaveCount(
      0,
    );
    await workspaces.click();
    await expect(
      page.getByRole("heading", { name: "My workspaces.", exact: true }),
    ).toBeVisible();
    await expect(workspaces).toHaveAttribute("aria-current", "page");
    await logo.focus();
    await logo.press("Enter");
    await expect(title).toBeVisible();
    await page
      .getByRole("button", { name: `Return to ${rootName}`, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "My workspaces.", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).welcomePickerCalls)).toBe(
      pickerCalls,
    );
    await expect(setup).toHaveCount(0);
    await page.reload();
    await expect(title).toBeVisible();
    const returning = page.getByRole("button", {
      name: `Return to ${rootName}`,
      exact: true,
    });
    await expect(returning).toBeVisible();
    await expect(returning).toBeEnabled();
    await expect(returning).toHaveAttribute("title", rootName);
    const firstChapter = await page.locator(".welcome-new").boundingBox();
    const welcomeHome = await page.locator(".welcome-return").boundingBox();
    expect(width > 600 ? firstChapter!.x : firstChapter!.y).toBeLessThan(
      width > 600 ? welcomeHome!.x : welcomeHome!.y,
    );
    await expect(page.getByText("Home options", { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: `artifacts/screenshots/welcome-return-${width}.png`,
      fullPage: true,
    });
    await page.evaluate(() =>
      Object.assign(window, {
        welcomePickerCalls: 0,
        showDirectoryPicker: async () => {
          (window as any).welcomePickerCalls++;
          throw new Error(
            "Returning to the remembered home should not select a new folder",
          );
        },
      }),
    );
    await returning.click();
    await expect(
      page.getByRole("button", { name: "Create workspace", exact: true }),
    ).toBeEnabled();
    await expect(setup).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).welcomePickerCalls)).toBe(
      0,
    );
    expect(errors).toEqual([]);
  });
}
