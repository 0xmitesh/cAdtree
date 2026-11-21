import { waitForScan } from "./rescan";
import { test, expect } from "@playwright/test";

// Real browser filesystem handles and IndexedDB, synthetic origin-private data only.
// The directory picker is replaced; OS picker/permission qualification is separate.
test("Cadtree home: create, import, capture, switch, reopen and rediscover in Chrome", async ({
  page,
}) => {
  const errors: string[] = [];
  const outbound: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:") &&
      !r.url().startsWith("data:")
    )
      outbound.push(r.url());
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const storage = await navigator.storage.getDirectory();
    const root = await storage.getDirectoryHandle(
      `home-test-${crypto.randomUUID()}`,
      { create: true },
    );
    const home = await root.getDirectoryHandle("Cadtree", { create: true });
    const source = await root.getDirectoryHandle("Original CAD", {
      create: true,
    });
    const parts = await source.getDirectoryHandle("Parts", { create: true });
    const file = await parts.getFileHandle("Part.SLDPRT", { create: true });
    const writer = await file.createWritable();
    await writer.write(new Uint8Array([0, 255, 16]));
    await writer.close();
    await source.getDirectoryHandle("Empty", { create: true });
    Object.assign(window, {
      showDirectoryPicker: async () => home,
      testHome: home,
      testSource: source,
    });
  });
  await page.getByRole("button", { name: "Start my Cadtree home" }).click();
  await page
    .getByRole("textbox", { name: "Cadtree home folder address" })
    .fill("D:\\Cadtree");
  await page
    .getByRole("button", { name: "Complete setup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [index, name] of [
    "Personal SolidWorks",
    "Client ABC",
    "AutoCAD",
  ].entries()) {
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByRole("textbox", { name: "Workspace name" }).fill(name);
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Choose folder" }),
    ).toHaveCount(0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create workspace" })
      .click();
    await expect(page.getByRole("heading", { name: name + "." })).toBeVisible();
    if (index < 2) {
      const explorerBefore = await page
        .locator(".desktop-workspace-tree")
        .boundingBox();
      expect(explorerBefore).not.toBeNull();
      await page.evaluate(() =>
        Object.assign(window, {
          showDirectoryPicker: async () =>
            (window as unknown as { testSource: FileSystemDirectoryHandle })
              .testSource,
        }),
      );
      await page
        .getByRole("button", { name: "Import existing project", exact: true })
        .click();
      await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(0);
      await page.screenshot({ path: "artifacts/screenshots/import-project.png" });
      await page.getByRole("button", { name: "Choose project folder" }).click();
      await expect(
        page.getByRole("textbox", { name: /What changed/ }),
      ).toBeEnabled();
      await page
        .getByRole("textbox", { name: /What changed/ })
        .fill(`Baseline ${name}`);
      await page
        .getByRole("button", { name: "Save version", exact: true })
        .click();
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      const explorerAfter = await page
        .locator(".desktop-workspace-tree")
        .boundingBox();
      const historyButton = await page
        .getByRole("navigation")
        .getByRole("button", { name: "History" })
        .boundingBox();
      expect(Math.abs(explorerAfter!.y - explorerBefore!.y)).toBeLessThan(1);
      expect(
        Math.abs(explorerAfter!.height - explorerBefore!.height),
      ).toBeLessThan(1);
      expect(historyButton!.y).toBeGreaterThan(
        explorerAfter!.y + explorerAfter!.height,
      );
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "History" })
        .click();
      await expect(
        page.getByRole("heading", { name: `Baseline ${name}` }),
      ).toBeVisible();
    }
    if (index === 2) {
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      const projectDialog = page.getByRole("dialog", { name: "Create project" });
      await expect(projectDialog.getByRole("textbox")).toHaveCount(1);
      await expect(
        projectDialog.getByRole("button", { name: /Choose/ }),
      ).toHaveCount(0);
      await projectDialog
        .getByRole("textbox", { name: "Project name" })
        .fill("New design");
      await page.screenshot({ path: "artifacts/screenshots/create-project.png" });
      await projectDialog
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await expect(projectDialog).toHaveCount(0);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await expect(page.getByRole("heading", { name: "0 changed files" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Project context" })).toHaveAttribute("data-branch-id", "branch-main");
    }
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "My workspaces" })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Open workspace", exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByRole("combobox", { name: "Working case" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation").getByRole("button", { name: "History" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "artifacts/screenshots/home-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .locator("body")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/screenshots/home-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Browse folders" }).click();
  const folderDialog = page.getByRole("dialog", { name: "Browse folders" });
  const explorer = folderDialog.getByRole("tree", {
    name: "Workspace explorer",
  });
  await expect(explorer).toBeVisible();
  await explorer.getByRole("treeitem", { name: "Cadtree home" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    explorer.getByRole("treeitem", { name: "AutoCAD", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: "artifacts/screenshots/folder-browser-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Enter");
  await expect(folderDialog).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "AutoCAD", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "My workspaces" })
    .click();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "Return to Cadtree" }).click();
  await expect(
    page.getByRole("button", { name: "Open workspace", exact: true }),
  ).toHaveCount(3);
  // Clear actual convenience data, retain the handle only in this test's browser context.
  const home = await page.evaluateHandle(async () => {
    const dbRequest = indexedDB.open("cadtree_convenience_v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = reject;
    });
    const tx = db.transaction("ui_preferences", "readonly");
    const req = tx.objectStore("ui_preferences").get("home");
    const saved = await new Promise<{ rootHandle: FileSystemDirectoryHandle }>(
      (resolve) => {
        req.onsuccess = () => resolve(req.result);
      },
    );
    db.close();
    const modulePath = "/src/engine/idb-store.ts";
    const service = await import(modulePath);
    await service.clearAllConvenienceMetadata();
    return saved.rootHandle;
  });
  await page.evaluate(
    (home) => Object.assign(window, { showDirectoryPicker: async () => home }),
    home,
  );
  // Returning home with no remembered binding must discover using one explicit selection.
  await page.getByText("Home options", { exact: true }).click();
  await page.getByRole("button", { name: "Switch Cadtree home" }).click();
  await expect(
    page.getByRole("button", { name: "Open workspace", exact: true }),
  ).toHaveCount(3);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Personal SolidWorks",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Open workspace" })
    .click();
  await page.getByRole("button", { name: "Open project" }).click();
  await expect(
    page.getByRole("heading", { name: "Baseline Personal SolidWorks" }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.screenshot({
    path: "artifacts/screenshots/home-project.png",
    fullPage: true,
  });
  // The loaded app can scan and capture using local data while the network is offline.
  await page.evaluate(async (home) => {
    const registry = await home.getDirectoryHandle(".cadtree-home");
    const records = await registry.getDirectoryHandle("workspaces");
    let directory = "";
    for await (const [name, handle] of (
      records as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemFileHandle]>;
      }
    ).entries()) {
      if (
        handle.kind !== "file" ||
        !name.endsWith(".json") ||
        name.endsWith(".ready.json")
      )
        continue;
      const record = JSON.parse(await (await handle.getFile()).text());
      if (record.name === "Personal SolidWorks") directory = record.directory;
    }
    const workspace = await home.getDirectoryHandle(directory);
    const projects = await workspace.getDirectoryHandle("projects");
    for await (const [, project] of (
      projects as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemDirectoryHandle]>;
      }
    ).entries()) {
      if (project.kind !== "directory") continue;
      const working = await (
        await project.getDirectoryHandle("working")
      ).getDirectoryHandle("main");
      const file = await working.getFileHandle("Offline edit.bin", {
        create: true,
      });
      const writer = await file.createWritable();
      await writer.write("Offline test bytes");
      await writer.close();
      break;
    }
  }, home);
  await page.context().setOffline(true);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Changes" })
    .click();
  await waitForScan(page);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("textbox", { name: /What changed/ })
    .fill("Offline version");
  await page
    .getByRole("button", { name: "Save version", exact: true })
    .click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History" })
    .click();
  await page.getByRole("button", { name: /Offline version/ }).click();
  await expect(
    page.getByRole("heading", { name: "Offline version", exact: true }),
  ).toBeVisible();
  await page.context().setOffline(false);
  expect(errors).toEqual([]);
  expect(outbound).toEqual([]);
});
