import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import App from "../App";
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../engine/home-service";
import { createProject } from "../engine/workspace-service";
import { copyVerifiedTree } from "../engine/copy-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { openHomeWorkspace, appBusy } from "../../tests/app-controls";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
});

const NEEDS_ATTENTION = /This project location needs attention/;
const projectOpen = (ui: ReturnType<typeof render>) =>
  Boolean(ui.container.querySelector(".project-context-header"));

async function copyProject(
  root: FileSystemDirectoryAdapter,
  containerPath: string,
  toPath: string,
) {
  const from = await root.getDirectory(containerPath.split("/"));
  const to = await root.getDirectory(toPath.split("/"), { create: true });
  await copyVerifiedTree(from, to);
}

async function fixture() {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace } = await createHomeWorkspace(home, "Engineering");
  const shared = await createProject(workspace.root, "Actuator");
  const normal = await createProject(workspace.root, "Gripper");
  return { home, root: workspace.root, shared, normal };
}

test("Projects list: Use this location is disabled for every copy sharing a project identity, and the reason is shown", async () => {
  const f = await fixture();
  await copyProject(f.root, f.shared.record.containerPath, "projects/Actuator copy");
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  // The normal project is a single location with its own Open button; the duplicates are grouped.
  assert.ok(within(ui.getByRole("heading", { name: "Actuator" }).closest(".workspace-project") as HTMLElement).getByText("Needs attention"));
  fireEvent.click(ui.getByRole("button", { name: "Choose location" }));
  const buttons = ui.getAllByRole("button", { name: "Use this location" }) as HTMLButtonElement[];
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => button.disabled));
  assert.ok(
    ui.getAllByText(/every copy stays read-only/).length >= 1,
  );
  for (const button of buttons) fireEvent.click(button);
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(projectOpen(ui), false);
});

test("openManaged guard: a copy that appears after the list was shown is refused, and a normal project still opens", async () => {
  const f = await fixture();
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  const open = ui.getAllByRole("button", { name: "Open project" });
  assert.equal(open.length, 2);
  // A second copy of Actuator appears on disk while the stale list is still on screen.
  await copyProject(f.root, f.shared.record.containerPath, "projects/Actuator copy");
  const actuatorRow = ui.getByRole("heading", { name: "Actuator" }).closest(".workspace-project") as HTMLElement;
  fireEvent.click(within(actuatorRow).getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.match(ui.container.textContent!, NEEDS_ATTENTION));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(projectOpen(ui), false);

  const gripperRow = ui.getByRole("heading", { name: "Gripper" }).closest(".workspace-project") as HTMLElement;
  fireEvent.click(within(gripperRow).getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(projectOpen(ui), true));
});

test("openManaged guard: a folder swapped for a different project after the list was shown is refused, not opened in its place", async () => {
  const f = await fixture();
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  // Replace the Actuator folder with Gripper's project (and remove Gripper's own folder).
  await copyProject(f.root, f.normal.record.containerPath, "projects/Swap");
  await f.root.removeEntry(f.shared.record.containerPath.split("/"), { recursive: true });
  await f.root.removeEntry(f.normal.record.containerPath.split("/"), { recursive: true });
  await copyProject(f.root, "projects/Swap", f.shared.record.containerPath);
  await f.root.removeEntry(["projects", "Swap"], { recursive: true });
  const actuatorRow = ui.getByRole("heading", { name: "Actuator" }).closest(".workspace-project") as HTMLElement;
  fireEvent.click(within(actuatorRow).getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.match(ui.container.textContent!, NEEDS_ATTENTION));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(projectOpen(ui), false);
});
