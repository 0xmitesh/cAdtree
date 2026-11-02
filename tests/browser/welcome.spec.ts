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
      name: "Create. Adapt. Define.",
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
    await expect(
      page.getByRole("main").getByText("Your files. Your storage.", {
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
    // Both existing native picker routes stay distinct; opening an empty folder
    // reports the existing error rather than silently creating a home.
    await open.click();
    await expect(
      page.locator(".home-welcome").getByRole("alert"),
    ).toBeVisible();
    expect(await entries()).toEqual([]);
    await start.focus();
    await start.press("Enter");
    const setup = page.getByRole("dialog", {
      name: "Complete home setup",
      exact: true,
    });
    await expect(setup).toBeVisible();
    expect(await page.evaluate(() => (window as any).welcomePickerCalls)).toBe(
      2,
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
