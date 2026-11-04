import "../../tests/dom";
import {
  openHomeWorkspace,
  appBusy,
  currentBranchId,
  selectBranch,
} from "../../tests/app-controls";
import { indexedDB as testIndexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import {
  FilePathActions,
  FilePathShortcutsProvider,
  WorkspaceLocationSetting,
} from "./FilePathShortcuts";
import {
  clearAllConvenienceMetadata,
  getWorkspaceWindowsPath,
  saveWorkspaceWindowsPath,
} from "../engine/idb-store";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  createWorkspace,
  importProject,
  createManagedBranch,
  openWorkspace,
  type WorkspaceState,
} from "../engine/workspace-service";
import { captureRevision } from "../engine/revision-service";
import { MAIN_BRANCH_ID } from "../engine/types";
import { nativeDirectory } from "../../tests/native-fs";
import {
  composeWindowsFilePaths,
  type FilePathLocation,
} from "../utils/windows-path";
import App from "../App";
import { createHome, createHomeWorkspace } from "../engine/home-service";

globalThis.indexedDB = testIndexedDB;

afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
});
const filePath = "Parts/内側/Bracket.SLDPRT";
const location: FilePathLocation = {
  workspaceId: "ws-one",
  relativeDirectory: "projects/p/working/actual-leaf",
  filePath,
};
function clipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}
function workspace(id = "ws-one") {
  return {
    root: new InMemoryFileSystemAdapter("Root"),
    identity: {
      schemaVersion: 1,
      workspaceId: id,
      name: "Design workspace",
      createdAt: "",
      payloadSha256: "",
    },
    projects: [],
  } satisfies WorkspaceState;
}
function harness(
  ws: WorkspaceState,
  resolve = async () => location,
  epoch = 0,
) {
  return (
    <FilePathShortcutsProvider workspace={ws} convenienceEpoch={epoch}>
      <WorkspaceLocationSetting />
      <FilePathActions filePath={filePath} resolve={resolve} />
    </FilePathShortcutsProvider>
  );
}
const copyButton = (ui: ReturnType<typeof render>) =>
  ui.getByRole("button", { name: `Copy folder path — ${filePath}` });

test("a first path click offers setup, saves locally, rechecks the file, then completes that exact copy", async () => {
  await clearAllConvenienceMetadata();
  const copied: string[] = [];
  clipboard(async (text) => {
    copied.push(text);
  });
  let checks = 0;
  const ui = render(
    harness(workspace(), async () => {
      checks++;
      return location;
    }),
  );
  fireEvent.click(copyButton(ui));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Set up folder-path copying" })),
  );
  assert.equal(copied.length, 0);
  assert.ok(ui.getByText(/How to copy and use a folder address/));
  fireEvent.change(ui.getByRole("textbox", { name: "Workspace folder path" }), {
    target: { value: '"D:\\CAD Workspace\\"' },
  });
  fireEvent.click(ui.getByRole("button", { name: "Save and copy" }));
  await waitFor(() => assert.equal(copied.length, 1));
  assert.equal(
    copied[0],
    composeWindowsFilePaths("D:\\CAD Workspace", location).folder,
  );
  assert.equal(checks, 2);
  assert.equal(await getWorkspaceWindowsPath("ws-one"), "D:\\CAD Workspace");
  assert.ok(ui.getByText("Folder path copied"));
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(copied.length, 2));
  assert.ok(ui.queryByRole("dialog") === null);
  fireEvent.click(ui.getByLabelText(`More path actions — ${filePath}`));
  fireEvent.click(
    ui.getByRole("button", { name: `Copy full file path — ${filePath}` }),
  );
  await waitFor(() => assert.equal(copied.length, 3));
  assert.equal(
    copied[2],
    composeWindowsFilePaths("D:\\CAD Workspace", location).file,
  );
  assert.ok(ui.getByText("File path copied"));
});

test("a branch-root file copies its working folder; the secondary action includes its filename", async () => {
  await saveWorkspaceWindowsPath("ws-one", "D:\\CAD Workspace");
  const copied: string[] = [];
  clipboard(async (value) => {
    copied.push(value);
  });
  const rootFile = "Assembly.SLDASM";
  const ui = render(
    <FilePathShortcutsProvider workspace={workspace()} convenienceEpoch={0}>
      <FilePathActions
        filePath={rootFile}
        resolve={async () => ({ ...location, filePath: rootFile })}
      />
    </FilePathShortcutsProvider>,
  );
  fireEvent.click(
    ui.getByRole("button", { name: `Copy folder path — ${rootFile}` }),
  );
  await waitFor(() => assert.equal(copied.length, 1));
  assert.equal(
    copied[0],
    "D:\\CAD Workspace\\projects\\p\\working\\actual-leaf",
  );
  assert.ok(ui.getByText("Folder path copied"));
  fireEvent.click(ui.getByLabelText(`More path actions — ${rootFile}`));
  fireEvent.click(
    ui.getByRole("button", { name: `Copy full file path — ${rootFile}` }),
  );
  await waitFor(() => assert.equal(copied.length, 2));
  assert.equal(copied[1], copied[0] + "\\Assembly.SLDASM");
  assert.ok(ui.getByText("File path copied"));
});

test("clipboard feedback waits for success; denied or unavailable access offers a selectable plain-path fallback", async () => {
  await saveWorkspaceWindowsPath("ws-one", "D:\\Workspace");
  let finish!: () => void;
  clipboard(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let ui = render(harness(workspace()));
  // A configured workspace must work even before the mount-time preference read finishes.
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.ok(ui.queryByText("Folder path copied") === null);
  await act(async () => finish());
  assert.ok(ui.getByText("Folder path copied"));
  cleanup();
  for (const write of [
    undefined,
    async () => {
      throw new DOMException("Denied", "NotAllowedError");
    },
  ]) {
    clipboard(write);
    ui = render(harness(workspace()));
    await waitFor(() => assert.ok(ui.getByText("D:\\Workspace")));
    fireEvent.click(copyButton(ui));
    await waitFor(() =>
      assert.ok(ui.getByRole("dialog", { name: "Copy path manually" })),
    );
    assert.equal(
      (ui.getByRole("textbox", { name: "Path to copy" }) as HTMLTextAreaElement)
        .value,
      composeWindowsFilePaths("D:\\Workspace", location).folder,
    );
    assert.ok(ui.queryByText("Folder path copied") === null);
    const field = ui.getByRole("textbox", {
      name: "Path to copy",
    }) as HTMLTextAreaElement;
    fireEvent.focus(field);
    assert.equal(field.selectionEnd, field.value.length);
    cleanup();
  }
});

test("workspace switching and clearing convenience data never reuse another workspace's absolute root", async () => {
  await saveWorkspaceWindowsPath("ws-one", "D:\\One");
  await saveWorkspaceWindowsPath("ws-two", "E:\\Two");
  const copied: string[] = [];
  clipboard(async (value) => {
    copied.push(value);
  });
  const ui = render(harness(workspace()));
  await waitFor(() => assert.ok(ui.getByText("D:\\One")));
  ui.rerender(
    harness(workspace("ws-two"), async () => ({
      ...location,
      workspaceId: "ws-two",
    })),
  );
  await waitFor(() => assert.ok(ui.getByText("E:\\Two")));
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(copied.length, 1));
  assert.ok(copied[0].startsWith("E:\\Two\\"));
  await clearAllConvenienceMetadata();
  ui.rerender(
    harness(
      workspace("ws-two"),
      async () => ({ ...location, workspaceId: "ws-two" }),
      1,
    ),
  );
  await waitFor(() => assert.ok(ui.getByText(/Not set/)));
  fireEvent.click(copyButton(ui));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Save and copy" })),
  );
  assert.equal(copied.length, 1);
});

test("missing files never reach clipboard success or fabricate a fallback; files are rechecked after configuration", async () => {
  const copied: string[] = [];
  clipboard(async (value) => {
    copied.push(value);
  });
  let exists = true;
  const ui = render(
    harness(workspace(), async () => {
      if (!exists)
        throw new Error(
          "The file is missing. Scan the branch or restore a copy.",
        );
      return location;
    }),
  );
  fireEvent.click(copyButton(ui));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Save and copy" })),
  );
  exists = false;
  fireEvent.change(ui.getByRole("textbox", { name: "Workspace folder path" }), {
    target: { value: "D:\\Workspace" },
  });
  fireEvent.click(ui.getByRole("button", { name: "Save and copy" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "File path unavailable" })),
  );
  assert.ok(ui.getByText(/file is missing/));
  assert.equal(copied.length, 0);
  assert.ok(ui.queryByRole("textbox", { name: "Path to copy" }) === null);
});

test("unconfigured shortcuts can be cancelled or invalid input corrected without writing preferences", async () => {
  clipboard(async () => {
    throw new Error("Must not copy");
  });
  const ui = render(harness(workspace()));
  fireEvent.click(copyButton(ui));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Save and copy" })),
  );
  fireEvent.change(ui.getByRole("textbox", { name: "Workspace folder path" }), {
    target: { value: "D:\\CAD\\..\\Elsewhere" },
  });
  fireEvent.click(ui.getByRole("button", { name: "Save and copy" }));
  await waitFor(() => assert.ok(ui.getByRole("alert")));
  assert.equal(await getWorkspaceWindowsPath("ws-one"), "");
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  assert.ok(ui.queryByRole("dialog") === null);
  assert.ok(ui.queryByText("Folder path copied") === null);
});

test("unavailable convenience storage keeps an entered location usable for this session and reports the limit", async () => {
  const previous = globalThis.indexedDB;
  Object.assign(globalThis, { indexedDB: undefined });
  try {
    const copied: string[] = [];
    clipboard(async (value) => {
      copied.push(value);
    });
    const ui = render(harness(workspace()));
    fireEvent.click(copyButton(ui));
    await waitFor(() =>
      assert.ok(ui.getByRole("button", { name: "Save and copy" })),
    );
    fireEvent.change(
      ui.getByRole("textbox", {
        name: "Workspace folder path",
      }),
      { target: { value: "D:\\Session" } },
    );
    fireEvent.click(ui.getByRole("button", { name: "Save and copy" }));
    await waitFor(() => assert.equal(copied.length, 1));
    assert.ok(ui.getByText(/available for this session only/));
    assert.equal(
      copied[0],
      composeWindowsFilePaths("D:\\Session", location).folder,
    );
    fireEvent.click(copyButton(ui));
    await waitFor(() => assert.equal(copied.length, 2));
  } finally {
    globalThis.indexedDB = previous;
  }
});

const nav = (ui: ReturnType<typeof render>, name: string) =>
  fireEvent.click(
    within(ui.getByRole("navigation")).getByRole("button", { name }),
  );
const idle = (ui: ReturnType<typeof render>) =>
  waitFor(() =>
    assert.equal(
      ui.container.querySelector("main")?.getAttribute("aria-busy"),
      "false",
    ),
  );

test("App keeps the workspace overview separate, copies explicit history-branch/current-file paths and restored-copy paths", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const created = await createHomeWorkspace(home, "Engineering workspace");
  const root = created.workspace.root;
  const ws = created.workspace;
  const source = new InMemoryFileSystemAdapter("Source");
  await source.writeFileText(filePath.split("/"), "initial");
  const project = await importProject(root, source, "Cam assembly");
  const baseline = await captureRevision(
    project.workingFolders[MAIN_BRANCH_ID]!,
    project.vaultDir,
    {
      branchId: MAIN_BRANCH_ID,
      summary: "Baseline",
      notes: { problem: "", modification: "", observations: "" },
    },
  );
  const branch = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: baseline.revision.manifest.revisionId,
    name: "Case A",
    reason: "Alternative",
  });
  await saveWorkspaceWindowsPath(ws.identity.workspaceId, "D:\\工程 Workspace");
  const picks: FileSystemDirectoryHandle[] = [];
  Object.assign(window, {
    showDirectoryPicker: async () => {
      const chosen = picks.shift();
      if (!chosen) throw new Error("No queued directory");
      return chosen;
    },
  });
  const copied: string[] = [];
  clipboard(async (value) => {
    copied.push(value);
  });
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
  await waitFor(() =>
    assert.ok(ui.getByRole("heading", { name: "Engineering workspace." })),
  );
  assert.ok(!ui.queryByRole("dialog"));
  await act(async () => {
    assert.equal(
      await getWorkspaceWindowsPath(ws.identity.workspaceId),
      "D:\\工程 Workspace",
    );
  });
  assert.ok(ui.getByRole("heading", { name: "Engineering workspace." }));
  assert.ok(ui.getByRole("heading", { name: "Cam assembly" }));
  assert.ok(ui.queryByRole("combobox", { name: "Active branch" }) === null);
  assert.ok(ui.container.querySelector(".workspace-folder-bar") === null);
  assert.equal(
    ui.container
      .querySelector(".project-location-details")!
      .hasAttribute("open"),
    false,
  );
  assert.equal(ui.container.querySelector(".workspace-menu"), null);
  assert.ok(ui.getByRole("button", { name: "Create project" }));
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  assert.equal(ui.container.querySelector(".workspace-header"), null);
  assert.match(
    ui.container.querySelector(".history-page .eyebrow")!.textContent!,
    /Cam assembly/,
  );
  nav(ui, "Settings");
  const settings = within(
    ui.container.querySelector<HTMLElement>(".settings-page")!,
  );
  fireEvent.click(
    settings.getByRole("button", { name: "Reconnect workspace" }),
  );
  await idle(ui);
  assert.ok(!ui.queryByRole("dialog"));
  nav(ui, "Changes");
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  fireEvent.click(ui.getByRole("button", { name: /Show 1 unchanged files/ }));
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(copied.length, 1));
  assert.equal(
    copied[0],
    composeWindowsFilePaths(`D:\\Cadtree\\${created.directory}`, {
      workspaceId: ws.identity.workspaceId,
      relativeDirectory: project.workingPaths[MAIN_BRANCH_ID],
      filePath,
    }).folder,
  );
  nav(ui, "History");
  await selectBranch(ui, branch.createdBranchId);
  await idle(ui);
  fireEvent.click(
    ui.getByRole("button", {
      name: `Copy folder path — Current file on Main · ${filePath}`,
    }),
  );
  await waitFor(() => assert.equal(copied.length, 2));
  assert.equal(copied[1], copied[0]); // inspecting Main while Case A is active
  assert.equal(currentBranchId(ui), branch.createdBranchId);
  assert.ok(ui.getByText(/Restore a copy for the exact historical bytes/));
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog")));
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", {
      name: "Restore copy",
    }),
  );
  await idle(ui);
  fireEvent.click(ui.getByText(/Restored files — copy paths/));
  fireEvent.click(
    ui.getByRole("button", {
      name: `Copy folder path — Restored copy · ${filePath}`,
    }),
  );
  await waitFor(() => assert.equal(copied.length, 3));
  assert.match(copied[2], /\\recoveries\\copy-[^\\]+\\Parts\\内側$/);
  picks.push(
    nativeDirectory(new InMemoryFileSystemAdapter("External recovery")),
  );
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog")));
  const externalReview = within(ui.getByRole("dialog"));
  fireEvent.click(
    externalReview.getByRole("checkbox", {
      name: "Choose an external destination instead",
    }),
  );
  fireEvent.click(
    externalReview.getByRole("button", { name: "Choose destination" }),
  );
  await idle(ui);
  assert.ok(
    ui.getByText(
      /full local path is not known for this external destination/,
    ),
  );
  assert.ok(
    !ui.queryByRole("button", { name: /^Copy folder path — Restored copy/ }),
  );
  assert.equal(copied.length, 3);
  assert.equal(
    (await openWorkspace(root)).projects[0].project!.vaultState.revisions
      .length,
    1,
  );
  fireEvent.click(
    ui.getByRole("treeitem", { name: "Engineering workspace" }),
  );
  assert.ok(ui.queryByRole("combobox", { name: "Active branch" }) === null);
  assert.ok(ui.container.querySelector(".workspace-folder-bar") === null);
  assert.ok(ui.queryByText(/Opened managed location/) === null);
  assert.ok(ui.getByRole("heading", { name: "Engineering workspace." }));
});
