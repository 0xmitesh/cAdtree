import { test, expect } from "@playwright/test";

// Real Chromium OPFS/IndexedDB; native selection is replaced with test handles.
test("required home address and compact Home options support cancel, keyboard access and saved reuse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(async () => {
    const storage = await navigator.storage.getDirectory();
    const first = await storage.getDirectoryHandle(
      `setup-${crypto.randomUUID()}`,
      { create: true },
    );
    Object.assign(window, {
      selectedHome: first,
      pickerCalls: 0,
      showDirectoryPicker: async () => {
        (window as any).pickerCalls++;
        return first;
      },
    });
  });
  await page
    .getByRole("button", { name: "Start my Cadtree home", exact: true })
    .click();
  const setup = page.getByRole("dialog", { name: "Complete home setup" });
  const address = setup.getByRole("textbox", {
    name: "Cadtree home folder address",
  });
  await expect(setup).toBeVisible();
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute("required", "");
  await expect(
    setup.getByRole("button", { name: /skip|not now/i }),
  ).toHaveCount(0);
  await setup
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  expect(
    await address.evaluate((el: HTMLInputElement) => el.validity.valueMissing),
  ).toBe(true);
  await address.fill("relative-folder");
  await setup
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  await expect(setup.getByRole("alert")).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/home-address-required.png",
    fullPage: false,
  });
  await setup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(setup).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const root = (window as any).selectedHome as FileSystemDirectoryHandle;
      const entries = [];
      for await (const name of (root as any).keys()) entries.push(name);
      return entries;
    }),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Start my Cadtree home", exact: true })
    .click();
  await address.fill('"d:\\工程 Designs\\Cadtree\\"');
  await setup
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  await expect(setup).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create workspace", exact: true }),
  ).toBeEnabled();
  const options = page.locator(".home-options > summary");
  await options.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Edit home folder address", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Import existing workspace",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch Cadtree home", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Inspect external workspaces",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/home-options-menu.png",
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Edit home folder address", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit home folder address" });
  await expect(edit.getByRole("textbox")).toHaveValue(
    "D:\\工程 Designs\\Cadtree",
  );
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect(options).toBeFocused();
  await options.click();
  await page
    .getByRole("button", { name: "Import existing workspace", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Import existing workspace" }),
  ).toContainText("original workspace and its files remain untouched");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Designs");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Designs." })).toBeVisible();
  await expect(setup).toHaveCount(0);
  await expect(
    page.getByText("Workspace options", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "My workspaces", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: /^Return to setup-/ }).click();
  await expect(
    page.getByRole("button", { name: "Open workspace", exact: true }),
  ).toBeVisible();
  await expect(setup).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await options.click();
  await page.screenshot({
    path: "artifacts/screenshots/home-options-mobile.png",
    fullPage: false,
  });
  expect(
    await page
      .locator("body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  expect(errors).toEqual([]);
});
