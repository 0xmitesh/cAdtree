import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import App from "../App";
import { nativeDirectory } from "../../tests/native-fs";
import { completeHomeAddress } from "../../tests/app-controls";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  createHome,
  createHomeWorkspace,
  openHome,
} from "../engine/home-service";
import { importProject } from "../engine/workspace-service";
import {
  clearAllConvenienceMetadata,
  getWorkspaceWindowsPath,
  saveWorkspaceWindowsPath,
} from "../engine/idb-store";
import {
  FilePathShortcutsProvider,
  FilePathActions,
} from "./FilePathShortcuts";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});
function picker(...folders: InMemoryFileSystemAdapter[]) {
  let calls = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      calls++;
      const root = folders.shift();
      if (!root) throw new Error("Unexpected picker");
      return nativeDirectory(root);
    },
  });
  return {
    calls: () => calls,
    add: (root: InMemoryFileSystemAdapter) => folders.push(root),
  };
}
const menu = (ui: ReturnType<typeof render>) =>
  fireEvent.click(ui.getByText("Home options"));
const ready = (ui: ReturnType<typeof render>) =>
  waitFor(() =>
    assert.equal(
      (
        ui.getByRole("button", {
          name: "Create workspace",
        }) as HTMLButtonElement
      ).disabled,
      false,
    ),
  );

test("native folder selection precedes required address; invalid, empty and cancelled setup never publish a new home", async () => {
  const first = new InMemoryFileSystemAdapter("First Cadtree");
  const second = new InMemoryFileSystemAdapter("Second Cadtree");
  const picked = picker(first, second, first);
  const ui = render(<App />);
  assert.equal(
    ui.queryByRole("textbox", { name: "Cadtree home folder address" }),
    null,
  );
  fireEvent.click(ui.getByRole("button", { name: "Create Cadtree home" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  assert.equal(picked.calls(), 1);
  assert.equal((await first.listEntries()).length, 0);
  const field = ui.getByRole("textbox", {
    name: "Cadtree home folder address",
  }) as HTMLInputElement;
  assert.equal(field.required, true);
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => assert.ok(ui.getByRole("alert")));
  fireEvent.change(field, { target: { value: "relative\\Cadtree" } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() =>
    assert.match(ui.getByRole("alert").textContent!, /absolute|full Windows/i),
  );
  assert.equal((await first.listEntries()).length, 0);
  fireEvent.change(field, { target: { value: "D:\\First" } });
  fireEvent.click(ui.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    assert.ok(ui.getByText("Second Cadtree", { exact: true })),
  );
  assert.equal(
    (
      ui.getByRole("textbox", {
        name: "Cadtree home folder address",
      }) as HTMLInputElement
    ).value,
    "",
  );
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  assert.equal((await second.listEntries()).length, 0);
  assert.equal(ui.queryByRole("button", { name: "Create workspace" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Create Cadtree home" }));
  await completeHomeAddress(ui, '"d:\\工程 Designs\\Cadtree\\"');
  await ready(ui);
  const home = await openHome(first);
  assert.equal(
    await getWorkspaceWindowsPath(home.identity.homeId, nativeDirectory(first)),
    "D:\\工程 Designs\\Cadtree",
  );
  assert.ok(
    !JSON.stringify(await first.readFileText([".cadtree-home.json"])).includes(
      "工程 Designs",
    ),
  );
});

test("two homes retain isolated addresses; saved paths reconnect without a prompt and cancelled switches leave the current home connected", async () => {
  const a = new InMemoryFileSystemAdapter("Cadtree A"),
    b = new InMemoryFileSystemAdapter("Cadtree B");
  const homeA = await createHome(a),
    homeB = await createHome(b);
  const picked = picker(a, b, a);
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Home A");
  await ready(ui);
  menu(ui);
  fireEvent.click(ui.getByRole("button", { name: "Switch Cadtree home" }));
  await completeHomeAddress(ui, '"\\\\server\\share\\Home B\\"');
  await ready(ui);
  assert.equal(
    await getWorkspaceWindowsPath(homeA.identity.homeId, nativeDirectory(a)),
    "D:\\Home A",
  );
  assert.equal(
    await getWorkspaceWindowsPath(homeB.identity.homeId, nativeDirectory(b)),
    "\\\\server\\share\\Home B",
  );
  menu(ui);
  fireEvent.click(ui.getByRole("button", { name: "Switch Cadtree home" }));
  await waitFor(() => assert.ok(ui.getByText("Cadtree A", { exact: true })));
  await ready(ui);
  assert.ok(!ui.queryByRole("dialog"));
  menu(ui);
  fireEvent.click(ui.getByRole("button", { name: "Edit home folder address" }));
  await waitFor(() =>
    assert.equal(
      (
        ui.getByRole("textbox", {
          name: "Cadtree home folder address",
        }) as HTMLInputElement
      ).value,
      "D:\\Home A",
    ),
  );
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  const c = new InMemoryFileSystemAdapter("Cadtree C");
  await createHome(c);
  picked.add(c);
  menu(ui);
  fireEvent.click(ui.getByRole("button", { name: "Switch Cadtree home" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  assert.ok(ui.getByText("Cadtree A", { exact: true }));
  // A separate browser session with cleared preferences must ask again before connecting.
  cleanup();
  await clearAllConvenienceMetadata();
  picked.add(a);
  const reopened = render(<App />);
  fireEvent.click(reopened.getByRole("button", { name: "Open Cadtree home" }));
  await waitFor(() =>
    assert.ok(reopened.getByRole("dialog", { name: "Complete home setup" })),
  );
  fireEvent.click(reopened.getByRole("button", { name: "Cancel" }));
  assert.equal(
    reopened.queryByRole("button", { name: "Create workspace" }),
    null,
  );
  assert.equal((await openHome(b)).identity.homeId, homeB.identity.homeId);
});

test("configured homes provide one-click descendant copies and one canonical address edit action", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  const home = await createHome(root);
  const workspace = (await createHomeWorkspace(root, "Designs")).workspace;
  const source = new InMemoryFileSystemAdapter("CAD");
  await source.writeFileText(["Parts", "Part.SLDPRT"], "synthetic");
  const project = await importProject(workspace.root, source, "Actuator");
  const picked = picker(root);
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await completeHomeAddress(ui, "D:\\Cadtree");
  await ready(ui);
  menu(ui);
  assert.equal(
    ui.getAllByRole("button", { name: "Edit home folder address" }).length,
    1,
  );
  fireEvent.click(ui.getByText("Home options"));
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Open project" })),
  );
  assert.equal(ui.queryByText("Workspace options"), null);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() =>
    assert.equal(
      ui.container.querySelector("main")!.getAttribute("aria-busy"),
      "false",
    ),
  );
  assert.equal(ui.queryByRole("dialog"), null);
  const file = "Parts/Part.SLDPRT";
  fireEvent.click(
    ui.getByRole("button", { name: `Copy folder path — ${file}` }),
  );
  await waitFor(() => assert.equal(copied.length, 1));
  const discovered = await openHome(root);
  const entry = discovered.workspaces[0];
  const expected =
    `D:\\Cadtree\\${entry.directory}\\${project.workingPaths["branch-main"]}\\Parts`.replaceAll(
      "/",
      "\\",
    );
  assert.equal(copied[0], expected);
  fireEvent.click(ui.getByLabelText(`More path actions — ${file}`));
  fireEvent.click(
    ui.getByRole("button", { name: `Copy full file path — ${file}` }),
  );
  await waitFor(() => assert.equal(copied[1], `${expected}\\Part.SLDPRT`));
  fireEvent.click(
    within(ui.getByRole("navigation")).getByRole("button", {
      name: "Settings",
    }),
  );
  assert.equal(
    ui.queryByRole("button", { name: "Configure path shortcuts" }),
    null,
  );
  assert.equal(picked.calls(), 1);
  assert.equal(
    await getWorkspaceWindowsPath(home.identity.homeId),
    "D:\\Cadtree",
  );
});

test("unexpectedly missing home configuration uses the same required dialog and resumes the pending copy", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree"),
    home = await createHome(root);
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  const ui = render(
    <FilePathShortcutsProvider
      home={home}
      workspace={null}
      convenienceEpoch={0}
    >
      <FilePathActions
        filePath="Part.SLDPRT"
        resolve={async () => ({
          workspaceId: home.identity.homeId,
          relativeDirectory: "projects/recorded/working/main",
          filePath: "Part.SLDPRT",
        })}
      />
    </FilePathShortcutsProvider>,
  );
  fireEvent.click(
    ui.getByRole("button", { name: "Copy folder path — Part.SLDPRT" }),
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  fireEvent.change(
    ui.getByRole("textbox", { name: "Cadtree home folder address" }),
    { target: { value: "D:\\Cadtree" } },
  );
  fireEvent.click(ui.getByRole("button", { name: "Save and copy" }));
  await waitFor(() =>
    assert.equal(copied[0], "D:\\Cadtree\\projects\\recorded\\working\\main"),
  );
});

test("home-address preference failures remain truthful and the address survives navigation for this session", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(root);
  const picked = picker(root, root);
  const previous = globalThis.indexedDB;
  Object.assign(globalThis, { indexedDB: undefined });
  try {
    const ui = render(<App />);
    fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
    await completeHomeAddress(ui, "D:\\Session Cadtree");
    await ready(ui);
    assert.match(ui.container.textContent!, /available for this session only/);
    menu(ui);
    fireEvent.click(ui.getByRole("button", { name: "Switch Cadtree home" }));
    await waitFor(() => assert.equal(picked.calls(), 2));
    await ready(ui);
    menu(ui);
    fireEvent.click(
      ui.getByRole("button", { name: "Edit home folder address" }),
    );
    await waitFor(() =>
      assert.equal(
        (
          ui.getByRole("textbox", {
            name: "Cadtree home folder address",
          }) as HTMLInputElement
        ).value,
        "D:\\Session Cadtree",
      ),
    );
  } finally {
    cleanup();
    Object.assign(globalThis, { indexedDB: previous });
  }
});

test("home identity is rechecked after address entry before saving or completing connection", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  const original = await createHome(root);
  const replacement = new InMemoryFileSystemAdapter("Replacement");
  const different = await createHome(replacement);
  picker(root);
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })),
  );
  await root.writeFileText(
    [".cadtree-home.json"],
    await replacement.readFileText([".cadtree-home.json"]),
  );
  fireEvent.change(
    ui.getByRole("textbox", { name: "Cadtree home folder address" }),
    { target: { value: "D:\\Cadtree" } },
  );
  fireEvent.click(ui.getByRole("button", { name: "Complete setup" }));
  await waitFor(() =>
    assert.match(
      ui.getByRole("dialog").textContent!,
      /identity changed during setup/,
    ),
  );
  assert.equal(ui.queryByRole("button", { name: "Create workspace" }), null);
  assert.equal(await getWorkspaceWindowsPath(original.identity.homeId), "");
  assert.equal(await getWorkspaceWindowsPath(different.identity.homeId), "");
});
