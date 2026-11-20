import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The offline restore page (`projects/<P>/_RESTORE cAdtree.html`, CLAUDE.md §2 Offline guide), run for real.
 *
 * Fixture: a real project is built in origin-private storage with the app's own engine (two revisions, a reference,
 * empty folders, a Unicode name, two names for the same bytes) and cAdtree's own writer, refreshProjectGuide,
 * produces the page. The page text is returned to Node.
 *
 * Mode 1 (single files) runs from a real file:// URL, as a person would open it: the vault objects are written
 * to a temp folder as `<sha256>.bin` and given to the page's file input; the download is read back from disk.
 *
 * Mode 2 (rebuild a revision) needs real directory handles. Playwright cannot drive the native folder picker, so
 * the page is served from the dev server's origin (page.route fulfils /__restore.html with the generated page, so
 * origin-private storage is available) and `window.showDirectoryPicker` is replaced by a stub (addInitScript). The
 * stub hands out the next handle from `window.__pickerQueue` and records its options in `window.__pickerCalls`. The
 * handles are real FileSystemDirectoryHandle objects from OPFS: the project's vault folder, and empty or
 * non-empty destination folders. Everything after the picker (reading the vault, the refusals, writing, hashing,
 * read-back) is the page's own code. The picker's read-only mode can't be enforced by the stub, so the tests
 * prove the vault is never written by comparing a full snapshot (names and SHA-256 of every file) before and after.
 */

interface Built {
  html: string;
  baseName: string;
  containerPath: string;
  revisions: { id: string; number: number }[];
  /** Latest revision's manifest. */
  files: { path: string; sha256: string; size: number }[];
  directories: string[];
  /** Every object of the project, as base64, by SHA-256. */
  objects: Record<string, string>;
  /** SHA-256 of named fixture bytes. */
  shas: Record<string, string>;
}

/** Builds the project and its page inside the browser, from the app's own modules. */
async function buildProject(page: Page): Promise<Built> {
  await page.goto("/");
  return page.evaluate(async () => {
    const mod = (path: string) => import(/* @vite-ignore */ path);
    const [{ RealFileSystemAdapter }, ws, { captureRevision }, { refreshProjectGuide }, refs, { scanBranchChanges }] = await Promise.all([
      mod("/src/engine/fs-adapter.ts"),
      mod("/src/engine/workspace-service.ts"),
      mod("/src/engine/revision-service.ts"),
      mod("/src/engine/offline-guide.ts"),
      mod("/src/engine/references.ts"),
      mod("/src/engine/scanner.ts"),
    ]);
    const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 17 + (i >> 3)) & 255);
    const storage = await navigator.storage.getDirectory();
    const baseName = `restore-${crypto.randomUUID()}`;
    const base = await storage.getDirectoryHandle(baseName, { create: true });
    const workspaceHandle = await base.getDirectoryHandle("Workspace", { create: true });
    const root = new RealFileSystemAdapter(workspaceHandle);
    await ws.createWorkspace(root);
    const project = await ws.createProject(root, "Packaging Gripper");
    const containerPath: string = project.record.containerPath;
    const vault = project.vaultDir;
    const main = project.workingFolders["branch-main"];
    const bracketV1 = bytesOf(3000, 1);
    const bracketV2 = bytesOf(3100, 2);
    const assembly = bytesOf(1500, 3);
    const shaft = bytesOf(2048, 4);
    const unicode = bytesOf(777, 5);
    await main.writeFileBytes(["Parts", "Bracket.SLDPRT"], bracketV1);
    await main.writeFileBytes(["Assembly", "Main.SLDASM"], assembly);
    await main.writeFileBytes(["Parts", "Deep", "Shaft.SLDPRT"], shaft);
    await main.writeFileBytes(["Parts", "Deep", "Shaft copy.SLDPRT"], shaft);
    await main.writeFileBytes(["Parts", "Ünïcode Teil.SLDPRT"], unicode);
    await main.writeFileBytes(["Zero.txt"], new Uint8Array(0));
    await main.getDirectory(["Empty folder"], { create: true });
    await main.getDirectory(["Parts", "Empty nested"], { create: true });
    const notes = { problem: "", modification: "", observations: "" };
    const first = await captureRevision(main, vault, { branchId: "branch-main", summary: "Base", notes, workingFolders: project.workingFolders });
    await main.writeFileBytes(["Parts", "Bracket.SLDPRT"], bracketV2);
    const scan = await scanBranchChanges(main, "branch-main", first.revision.manifest);
    const second = await captureRevision(main, vault, {
      branchId: "branch-main",
      summary: "Stiffer bracket <b>bold</b> & more",
      notes,
      workingFolders: project.workingFolders,
      reviewedChangesSignature: scan.changesSignature,
      referenceReview: refs.createReferenceReview(first.vaultState, scan),
      referenceAuthor: { id: "a", displayName: "Asha" },
      referenceAttachments: [{ source: new File([new Uint8Array([9, 8, 7, 6])], "Datasheet.pdf"), explanation: "Load limits" }],
    });
    const result = await refreshProjectGuide(root, containerPath);
    if (result.status !== "written") throw new Error(`guide refresh: ${JSON.stringify(result)}`);
    const container = await root.getDirectory(containerPath.split("/"));
    const html: string = await container.readFileText(["_RESTORE cAdtree.html"]);

    const sha = async (data: Uint8Array<ArrayBuffer>) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
    let dir = base;
    for (const part of ["Workspace", ...containerPath.split("/"), "vault", "objects"]) dir = await dir.getDirectoryHandle(part);
    const objects: Record<string, string> = {};
    for await (const [, shardHandle] of (dir as any).entries()) {
      for await (const [name, handle] of shardHandle.entries()) {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        let text = "";
        for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        objects[name.replace(/\.bin$/, "")] = btoa(text);
      }
    }
    const manifest = second.revision.manifest;
    return {
      html,
      baseName,
      containerPath,
      revisions: [first, second].map((r) => ({ id: r.revision.manifest.revisionId, number: r.revision.manifest.displayNumber })),
      files: manifest.files.map((f: any) => ({ path: f.path, sha256: f.sha256, size: f.size })),
      directories: manifest.directories as string[],
      objects,
      shas: { bracketV1: await sha(bracketV1), bracketV2: await sha(bracketV2), assembly: await sha(assembly), shaft: await sha(shaft), unicode: await sha(unicode) },
    };
  });
}

const bytesFromBase64 = (text: string) => Buffer.from(text, "base64");

test.describe("restore page, Mode 1: single files from a file:// page", () => {
  test("a vault object is recognised and saved under its original name; unknown and damaged files are reported", async ({ page, context }) => {
    test.setTimeout(120000);
    const built = await buildProject(page);
    const folder = mkdtempSync(join(tmpdir(), "cadtree-restore-"));
    const pagePath = join(folder, "_RESTORE cAdtree.html");
    writeFileSync(pagePath, built.html, "utf8");
    const filePath = (name: string) => join(folder, name);
    const write = (name: string, data: Buffer) => { writeFileSync(filePath(name), data); return filePath(name); };
    const object = (sha: string) => write(`${sha}.bin`, bytesFromBase64(built.objects[sha]!));
    const reference = Object.keys(built.objects).find((sha) => bytesFromBase64(built.objects[sha]!).length === 4)!;

    const viewer = await context.newPage();
    const errors: string[] = [];
    const outbound: string[] = [];
    viewer.on("pageerror", (e) => errors.push(e.message));
    viewer.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
    viewer.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) outbound.push(r.url()); });
    await viewer.goto(pathToFileURL(pagePath).href);
    expect(await viewer.evaluate(() => [window.isSecureContext, typeof crypto.subtle?.digest])).toEqual([true, "function"]);
    await expect(viewer.locator("#project-name")).toHaveText("Packaging Gripper");
    await expect(viewer.locator("#generated-at")).not.toBeEmpty();
    // The summary text in a record can't have become markup anywhere on the page.
    expect(await viewer.locator("#mode1 b, #mode2 b").count()).toBe(0);

    // A changed file: the latest bytes of Bracket.SLDPRT.
    const input = viewer.locator("#file-picker");
    await input.setInputFiles(object(built.shas.bracketV2!));
    const card = viewer.locator("#results1 .card").first();
    await expect(card).toContainText("Matches the project's history");
    await expect(card).toContainText("V2, Main, Parts/Bracket.SLDPRT");
    expect(await card.getByRole("button").count()).toBe(1);
    const [download] = await Promise.all([viewer.waitForEvent("download"), card.getByRole("button", { name: 'Save as "Bracket.SLDPRT"' }).click()]);
    expect(download.suggestedFilename()).toBe("Bracket.SLDPRT");
    expect(readFileSync((await download.path())!).equals(bytesFromBase64(built.objects[built.shas.bracketV2!]!))).toBe(true);

    // The same bytes saved under two names: one button each. A Unicode name survives. Several files at once.
    await input.setInputFiles([object(built.shas.shaft!), object(built.shas.unicode!), object(built.shas.bracketV1!)]);
    const cards = viewer.locator("#results1 .card");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText("Matches the project's history");
    await expect(cards.nth(0).getByRole("button")).toHaveText(['Save as "Shaft copy.SLDPRT"', 'Save as "Shaft.SLDPRT"']);
    const [shaftDownload] = await Promise.all([viewer.waitForEvent("download"), cards.nth(0).getByRole("button", { name: 'Save as "Shaft copy.SLDPRT"' }).click()]);
    expect(shaftDownload.suggestedFilename()).toBe("Shaft copy.SLDPRT");
    const [unicodeDownload] = await Promise.all([viewer.waitForEvent("download"), cards.nth(1).getByRole("button").click()]);
    expect(unicodeDownload.suggestedFilename()).toBe("Ünïcode Teil.SLDPRT");
    expect(readFileSync((await unicodeDownload.path())!).equals(bytesFromBase64(built.objects[built.shas.unicode!]!))).toBe(true);
    await expect(cards.nth(2)).toContainText("V1, Main, Parts/Bracket.SLDPRT");

    // A reference document.
    await input.setInputFiles(object(reference));
    await expect(viewer.locator("#results1 .card")).toContainText("Reference:");
    const [referenceDownload] = await Promise.all([viewer.waitForEvent("download"), viewer.locator("#results1 .card").getByRole("button").click()]);
    expect(referenceDownload.suggestedFilename()).toBe("Datasheet.pdf");

    // Not in this project's history: never a guess.
    await input.setInputFiles(write("something else.bin", Buffer.from("not from this vault")));
    await expect(viewer.locator("#results1 .card")).toContainText("Not in this project's history");
    expect(await viewer.locator("#results1 .card").getByRole("button").count()).toBe(0);

    // A file named like an object whose bytes are different: damaged.
    const damagedName = `${built.shas.assembly}.bin`;
    const damaged = Buffer.from(bytesFromBase64(built.objects[built.shas.assembly!]!));
    damaged[10] ^= 0xff;
    await input.setInputFiles(write(damagedName, damaged));
    await expect(viewer.locator("#results1 .card")).toContainText("Damaged: the bytes don't match the name");
    expect(await viewer.locator("#results1 .card").getByRole("button").count()).toBe(0);
    // The same file with its true bytes is fine.
    await input.setInputFiles(write(damagedName, bytesFromBase64(built.objects[built.shas.assembly!]!)));
    await expect(viewer.locator("#results1 .card")).toContainText("V1, Main, Assembly/Main.SLDASM");

    expect(errors).toEqual([]);
    expect(outbound).toEqual([]);
  });

  test("dropping files works the same as choosing them", async ({ page, context }) => {
    test.setTimeout(120000);
    const built = await buildProject(page);
    const folder = mkdtempSync(join(tmpdir(), "cadtree-restore-"));
    const pagePath = join(folder, "page.html");
    writeFileSync(pagePath, built.html, "utf8");
    const viewer = await context.newPage();
    await viewer.goto(pathToFileURL(pagePath).href);
    const data = bytesFromBase64(built.objects[built.shas.assembly!]!).toString("base64");
    await viewer.evaluate((payload) => {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "9a5f-unrelated-name.bin"));
      document.querySelector("#drop-zone")!.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, data);
    await expect(viewer.locator("#results1 .card")).toContainText("V1, Main, Assembly/Main.SLDASM");
  });
});

/** Opens the generated page from the dev server's origin with the folder picker replaced (see the header). */
async function openRestorePage(page: Page, html: string): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__pickerQueue = [];
    w.__pickerCalls = [];
    w.showDirectoryPicker = async (options: unknown) => {
      w.__pickerCalls.push(options);
      const next = w.__pickerQueue.shift();
      if (!next) throw new DOMException("The user aborted a request.", "AbortError");
      return next;
    };
    // Names and SHA-256 of everything below a directory, for before/after comparisons and tree checks.
    w.__snapshot = async (dir: any, prefix = ""): Promise<string[]> => {
      const out: string[] = [];
      for await (const [name, handle] of dir.entries()) {
        const path = prefix + name;
        if (handle.kind === "directory") {
          out.push(`D ${path}`, ...(await w.__snapshot(handle, `${path}/`)));
        } else {
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await (await handle.getFile()).arrayBuffer()));
          out.push(`F ${path} ${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
        }
      }
      return out.sort();
    };
    w.__dir = async (baseName: string, ...parts: string[]) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [baseName, ...parts]) dir = await dir.getDirectoryHandle(part);
      return dir;
    };
    /** Creates a folder in storage (not in the vault), with optional files, and queues it for the next picker call. */
    w.__queueFolder = async (name: string, files: Record<string, string>) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("destinations", { create: true })).getDirectoryHandle(name, { create: true });
      for (const [file, text] of Object.entries(files)) {
        const writer = await (await dir.getFileHandle(file, { create: true })).createWritable();
        await writer.write(text);
        await writer.close();
      }
      w.__pickerQueue.push(dir);
      w.__lastQueued = dir;
      return dir;
    };
  });
  await page.route("**/__restore.html", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await page.goto("/__restore.html");
  await expect(page.locator("#project-name")).toHaveText("Packaging Gripper");
}

const queueVault = (page: Page, built: Built) =>
  page.evaluate(async ({ baseName, containerPath }) => {
    const w = window as any;
    w.__vault = await w.__dir(baseName, "Workspace", ...containerPath.split("/"), "vault");
    w.__pickerQueue.push(w.__vault);
  }, built);

async function chooseVaultAndRevision(page: Page, built: Built, number: string): Promise<void> {
  await queueVault(page, built);
  await page.locator("#choose-vault").click();
  await expect(page.locator("#vault-status")).toContainText("Vault found: 2 complete version(s)");
  await expect(page.locator("#revision-list label")).toHaveCount(2);
  await page.locator("#revision-list label", { hasText: number }).locator("input").check();
}

test.describe("restore page, Mode 2: rebuild a whole version (picker stubbed with real OPFS handles)", () => {
  test("reads the vault read-only, refuses bad destinations, rebuilds every folder and file and verifies them", async ({ page }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
    const built = await buildProject(page);
    await openRestorePage(page, built.html);
    expect(await page.evaluate(() => typeof (window as any).showDirectoryPicker)).toBe("function");

    // Step 1: not a vault folder is refused with a plain explanation.
    await page.evaluate(async () => {
      const w = window as any;
      await w.__queueFolder("not-a-vault", { "readme.txt": "hello" });
    });
    await page.locator("#choose-vault").click();
    await expect(page.locator("#vault-status")).toContainText("doesn't look like a project's vault");

    // A scratch folder inside the vault, for the "inside the vault" refusal. It is created before the snapshot.
    await queueVault(page, built);
    await page.evaluate(async () => {
      const w = window as any;
      await w.__vault.getDirectoryHandle("scratch-empty", { create: true });
    });
    await page.locator("#choose-vault").click();
    await expect(page.locator("#vault-status")).toContainText("Vault found: 2 complete version(s)");
    const labels = page.locator("#revision-list label");
    await expect(labels).toHaveCount(2);
    await expect(labels.nth(0)).toContainText("V1");
    await expect(labels.nth(0)).toContainText("Main");
    await expect(labels.nth(0)).toContainText("Base");
    await expect(labels.nth(1)).toContainText("V2");
    // The summary is shown as text, not markup.
    await expect(labels.nth(1)).toContainText("Stiffer bracket <b>bold</b> & more");
    expect(await page.locator("#revision-list b").count()).toBe(0);
    await expect(page.locator("#choose-dest")).toBeDisabled();
    await labels.nth(1).locator("input").check();
    await expect(page.locator("#choose-dest")).toBeEnabled();
    await expect(page.locator("#rebuild")).toBeDisabled();

    const vaultBefore: string[] = await page.evaluate(() => (window as any).__snapshot((window as any).__vault));
    expect(vaultBefore.some((line) => line.startsWith("F objects/"))).toBe(true);

    // Step 3: refusals. A folder that is not empty.
    await page.evaluate(() => (window as any).__queueFolder("not-empty", { "keep.txt": "mine" }));
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("not empty");
    await expect(page.locator("#rebuild")).toBeDisabled();
    // A folder inside the vault (empty, so only its place makes it wrong).
    await page.evaluate(async () => { const w = window as any; w.__pickerQueue.push(await w.__vault.getDirectoryHandle("scratch-empty")); });
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("inside the vault");
    await expect(page.locator("#rebuild")).toBeDisabled();
    // The vault itself.
    await page.evaluate(() => { const w = window as any; w.__pickerQueue.push(w.__vault); });
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("vault itself");
    await expect(page.locator("#rebuild")).toBeDisabled();
    // The folder that holds the vault.
    await page.evaluate(async ({ baseName, containerPath }) => {
      const w = window as any;
      w.__pickerQueue.push(await w.__dir(baseName, "Workspace", ...containerPath.split("/")));
    }, built);
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("vault is inside that folder");
    await expect(page.locator("#rebuild")).toBeDisabled();
    // A cancelled picker changes nothing.
    await page.locator("#choose-dest").click();
    await expect(page.locator("#rebuild")).toBeDisabled();

    // An empty folder, with only OS clutter in it, is accepted.
    await page.evaluate(() => (window as any).__queueFolder("empty-with-clutter", { ".DS_Store": "x", "Thumbs.db": "x", "desktop.ini": "x", "._Ghost": "x" }));
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("Empty folder chosen");
    await expect(page.locator("#rebuild")).toBeEnabled();

    // Step 4.
    await page.locator("#rebuild").click();
    const total = built.files.length;
    await expect(page.locator("#report")).toContainText(`V2: ${total} of ${total} file(s) written, 0 missing, 0 damaged, 0 failed;`);
    await expect(page.locator("#report .status.good")).toBeVisible();
    // Success changes nothing about the picker modes: the vault was asked for read-only, the destination for read-write.
    expect(await page.evaluate(() => (window as any).__pickerCalls.map((c: any) => c?.mode))).toEqual(
      ["read", "read", "readwrite", "readwrite", "readwrite", "readwrite", "readwrite", "readwrite"],
    );

    // The rebuilt tree equals the manifest: every folder (empty ones too), every name, every byte.
    const rebuilt: string[] = await page.evaluate(() => (window as any).__snapshot((window as any).__lastQueued));
    const clutter = new Set(["F .DS_Store", "F Thumbs.db", "F desktop.ini", "F ._Ghost"]);
    const actual = rebuilt.filter((line) => !clutter.has(line.split(" ").slice(0, 2).join(" ")));
    const directories = new Set<string>(built.directories);
    for (const file of built.files) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
    }
    const expected = [
      ...[...directories].map((d) => `D ${d}`),
      ...built.files.map((f) => `F ${f.path} ${f.sha256}`),
    ].sort();
    expect(actual).toEqual(expected);
    expect(actual).toContain("D Empty folder");
    expect(actual).toContain("D Parts/Empty nested");
    expect(actual.some((line) => line.startsWith("F Parts/Ünïcode Teil.SLDPRT "))).toBe(true);
    expect(actual.some((line) => line.startsWith("F Zero.txt "))).toBe(true);

    // Nothing was ever written into the vault.
    expect(await page.evaluate(() => (window as any).__snapshot((window as any).__vault))).toEqual(vaultBefore);
    // The page asks for another empty folder for another rebuild.
    await expect(page.locator("#rebuild")).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("a missing and a damaged object are reported without stopping the other files, and nothing is written into the vault", async ({ page }) => {
    test.setTimeout(120000);
    const built = await buildProject(page);
    // Damage the vault the way a bad disk could: one object loses a byte, another disappears, a third keeps its size but changes.
    const tampered = await page.evaluate(async ({ baseName, containerPath, shas }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [baseName, "Workspace", ...containerPath.split("/"), "vault", "objects"]) dir = await dir.getDirectoryHandle(part);
      const find = async (sha: string) => {
        const shard = await dir.getDirectoryHandle(sha.slice(0, 2));
        return { shard, name: `${sha}.bin`, handle: await shard.getFileHandle(`${sha}.bin`) };
      };
      const shorter = await find(shas.assembly);
      const original = new Uint8Array(await (await shorter.handle.getFile()).arrayBuffer());
      let writer = await shorter.handle.createWritable();
      await writer.write(original.subarray(0, original.length - 1));
      await writer.close();
      const gone = await find(shas.unicode);
      await gone.shard.removeEntry(gone.name);
      const flipped = await find(shas.shaft);
      const bytes = new Uint8Array(await (await flipped.handle.getFile()).arrayBuffer());
      bytes[5] ^= 0xff;
      writer = await flipped.handle.createWritable();
      await writer.write(bytes);
      await writer.close();
      return true;
    }, built);
    expect(tampered).toBe(true);

    await openRestorePage(page, built.html);
    await chooseVaultAndRevision(page, built, "V2");
    const vaultBefore: string[] = await page.evaluate(() => (window as any).__snapshot((window as any).__vault));
    await page.evaluate(() => (window as any).__queueFolder("rebuild-target", {}));
    await page.locator("#choose-dest").click();
    await expect(page.locator("#dest-status")).toContainText("Empty folder chosen");
    await page.locator("#rebuild").click();

    const total = built.files.length;
    // Shaft.SLDPRT and "Shaft copy.SLDPRT" share the flipped object; the Unicode file is gone; Main.SLDASM is a byte short.
    await expect(page.locator("#report")).toContainText(`V2: ${total - 4} of ${total} file(s) written, 1 missing, 3 damaged, 0 failed;`);
    await expect(page.locator("#report .status.bad")).toBeVisible();
    await expect(page.locator("#report")).toContainText("Do not use this rebuilt folder as the full version");
    const rows = page.locator("#report table").first().locator("tr");
    await expect(rows.filter({ hasText: "missing" })).toContainText("Parts/Ünïcode Teil.SLDPRT");
    await expect(rows.filter({ hasText: "damaged" })).toHaveCount(3);
    await expect(rows.filter({ hasText: "Assembly/Main.SLDASM" })).toContainText("bytes");
    await expect(rows.filter({ hasText: "Parts/Deep/Shaft.SLDPRT" })).toContainText("checksum does not match");

    const rebuilt: string[] = await page.evaluate(() => (window as any).__snapshot((window as any).__lastQueued));
    const written = rebuilt.filter((line) => line.startsWith("F "));
    const expectedWritten = built.files
      .filter((f) => !/Main\.SLDASM|Shaft|Ünïcode/.test(f.path))
      .map((f) => `F ${f.path} ${f.sha256}`)
      .sort();
    expect(written).toEqual(expectedWritten);
    expect(rebuilt).toContain("D Empty folder");
    expect(await page.evaluate(() => (window as any).__snapshot((window as any).__vault))).toEqual(vaultBefore);
  });

  test("V1 rebuilds its own older bytes", async ({ page }) => {
    test.setTimeout(120000);
    const built = await buildProject(page);
    await openRestorePage(page, built.html);
    await chooseVaultAndRevision(page, built, "V1");
    await page.evaluate(() => (window as any).__queueFolder("older", {}));
    await page.locator("#choose-dest").click();
    await page.locator("#rebuild").click();
    await expect(page.locator("#report .status.good")).toContainText("V1:");
    const rebuilt: string[] = await page.evaluate(() => (window as any).__snapshot((window as any).__lastQueued));
    expect(rebuilt).toContain(`F Parts/Bracket.SLDPRT ${built.shas.bracketV1}`);
    expect(rebuilt.some((line) => line.includes(String(built.shas.bracketV2)))).toBe(false);
  });

  test("a vault with an unreadable or tampered record lists the others and says what it skipped", async ({ page }) => {
    test.setTimeout(120000);
    const built = await buildProject(page);
    await page.evaluate(async ({ baseName, containerPath, id }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of [baseName, "Workspace", ...containerPath.split("/"), "vault", "revisions"]) dir = await dir.getDirectoryHandle(part);
      const writer = await (await dir.getFileHandle(`${id}.manifest.json`)).createWritable();
      await writer.write("{ not json");
      await writer.close();
    }, { baseName: built.baseName, containerPath: built.containerPath, id: built.revisions[1]!.id });
    await openRestorePage(page, built.html);
    await queueVault(page, built);
    await page.locator("#choose-vault").click();
    await expect(page.locator("#vault-status")).toContainText("Vault found: 1 complete version(s)");
    await expect(page.locator("#revision-list label")).toHaveCount(1);
    await expect(page.locator("#revision-list")).toContainText(`Version ${built.revisions[1]!.id} is not listed`);
  });
});

test("the page's checksum of a manifest agrees with the engine's, and versions failing the integrity rule are listed but cannot be rebuilt", async ({ page }) => {
  test.setTimeout(120000);
  const built = await buildProject(page);
  // Real manifests, through the engine's own function (on the app page) and the page's port of it (on the restore page).
  const engine = await page.evaluate(async ({ baseName, containerPath }) => {
    const path = "/src/engine/vault-service.ts";
    const { computeManifestPayloadChecksum } = await import(/* @vite-ignore */ path);
    let dir = await navigator.storage.getDirectory();
    for (const part of [baseName, "Workspace", ...containerPath.split("/"), "vault", "revisions"]) dir = await dir.getDirectoryHandle(part);
    const out: { manifest: unknown; checksum: string }[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
      if (!name.endsWith(".manifest.json")) continue;
      const manifest = JSON.parse(await (await handle.getFile()).text());
      out.push({ manifest, checksum: computeManifestPayloadChecksum(manifest) });
    }
    return out;
  }, built);
  await openRestorePage(page, built.html);
  const ported: string[] = await page.evaluate(
    (manifests) => Promise.all(manifests.map((m) => (window as any).__cadtreePayloadChecksum(m))),
    engine.map((entry) => entry.manifest),
  );
  const agreement = engine.map((entry, index) => [entry.checksum, ported[index]!]);
  expect(agreement.length).toBe(2);
  for (const [engine, ported] of agreement) expect(ported).toBe(engine);

  // Tamper with Rev 002's number inside its manifest and re-seal the file checksum in its completion record,
  // so only the payload checksum and the completion record's number can catch it.
  const secondId = built.revisions[1]!.id;
  await page.evaluate(async ({ baseName, containerPath, id }) => {
    let vault = await navigator.storage.getDirectory();
    for (const part of [baseName, "Workspace", ...containerPath.split("/"), "vault"]) vault = await vault.getDirectoryHandle(part);
    const revisions = await vault.getDirectoryHandle("revisions");
    const completed = await vault.getDirectoryHandle("completed");
    const manifestHandle = await revisions.getFileHandle(`${id}.manifest.json`);
    const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
    manifest.displayNumber = 7;
    const text = JSON.stringify(manifest);
    let writer = await manifestHandle.createWritable();
    await writer.write(text);
    await writer.close();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    const doneHandle = await completed.getFileHandle(`${id}.done.json`);
    const done = JSON.parse(await (await doneHandle.getFile()).text());
    done.manifestSha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    writer = await doneHandle.createWritable();
    await writer.write(JSON.stringify(done));
    await writer.close();
  }, { baseName: built.baseName, containerPath: built.containerPath, id: secondId });
  await queueVault(page, built);
  await page.locator("#choose-vault").click();
  await expect(page.locator("#vault-status")).toContainText("Vault found: 1 complete version(s) and 1 damaged");
  const damaged = page.locator("#revision-list label", { hasText: "damaged" });
  await expect(damaged).toHaveCount(1);
  await expect(damaged).toContainText("cannot rebuild");
  await expect(damaged).toContainText("does not match");
  await expect(damaged.locator("input")).toBeDisabled();
  await expect(page.locator("#revision-list label", { hasText: "V1" }).locator("input")).toBeEnabled();
});

test("a browser without the folder picker still offers single files and explains Mode 2", async ({ page, context }) => {
  test.setTimeout(120000);
  const built = await buildProject(page);
  const folder = mkdtempSync(join(tmpdir(), "cadtree-restore-"));
  const pagePath = join(folder, "page.html");
  writeFileSync(pagePath, built.html, "utf8");
  const viewer = await context.newPage();
  await viewer.addInitScript(() => { delete (window as any).showDirectoryPicker; Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }); });
  await viewer.goto(pathToFileURL(pagePath).href);
  await expect(viewer.locator("#mode2-body")).toContainText("needs a browser that can open folders");
  await expect(viewer.locator("#choose-vault")).toHaveCount(0);
  await expect(viewer.locator("#drop-zone")).toBeVisible();
});
