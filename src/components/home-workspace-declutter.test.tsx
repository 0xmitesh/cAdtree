import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { render, cleanup, within } from "@testing-library/react";
import App from "../App";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../engine/home-service";
import { createProject } from "../engine/workspace-service";
import { copyVerifiedTree } from "../engine/copy-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { openTestHome, openHomeWorkspace } from "../../tests/app-controls";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
});

async function healthyHome() {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace } = await createHomeWorkspace(home, "Engineering");
  await createProject(workspace.root, "Actuator");
  return { home, root: workspace.root };
}

/** A project whose Main working folder was removed: its status is no longer "ready". */
async function damagedProjectHome() {
  const f = await healthyHome();
  const project = await createProject(f.root, "Gripper");
  await f.root.removeEntry(project.workingPaths["branch-main"].split("/"), { recursive: true });
  return f;
}

const row = (ui: ReturnType<typeof render>, name: string) =>
  ui.getByRole("heading", { name }).closest(".workspace-project") as HTMLElement;

test("Workspace page: a healthy project shows no Managed project line and no location details", async () => {
  const f = await healthyHome();
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  const card = within(row(ui, "Actuator"));
  assert.ok(card.getByRole("button", { name: "Open project" }));
  assert.equal(ui.container.textContent!.includes("Managed project"), false);
  assert.equal(ui.container.textContent!.includes("One shared vault"), false);
  assert.equal(card.queryByText("Location details"), null);
  assert.equal(card.queryByRole("button", { name: "Choose location" }), null);
  assert.equal(card.queryByRole("button", { name: "Inspect project" }), null);
  assert.ok(card.getByText("Ready"));
  assert.equal(card.queryByText("Needs attention"), null);
});

test("Workspace page: a project that needs attention shows its location details and Inspect project", async () => {
  const f = await damagedProjectHome();
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  const healthy = within(row(ui, "Actuator"));
  assert.equal(healthy.queryByText("Location details"), null);
  const damaged = within(row(ui, "Gripper"));
  assert.ok(damaged.getByText("Location details"));
  assert.ok(damaged.getByRole("button", { name: "Inspect project" }));
  assert.ok(damaged.getByText("Needs attention"));
  assert.ok(damaged.getByText(/Connections or records need attention/));
  assert.equal(damaged.queryByText("Ready"), null);
});

test("Home: a healthy workspace shows no location details; a missing one does", async () => {
  const f = await healthyHome();
  const missing = await createHomeWorkspace(f.home, "Missing workspace");
  await f.home.removeEntry([missing.directory], { recursive: true });
  const ui = render(<App />);
  await openTestHome(ui, f.home);
  const healthy = within(row(ui, "Engineering"));
  assert.equal(healthy.queryByText(/Location details/), null);
  assert.ok(healthy.getByRole("button", { name: "Open workspace" }));
  assert.ok(healthy.getByText("1 project · Ready"));
  const gone = within(row(ui, "Missing workspace"));
  assert.ok(gone.getByText(/Location details/));
  assert.equal(gone.queryByRole("button", { name: "Open workspace" }), null);
  assert.ok(gone.getByText("Needs attention"));
  assert.ok(gone.getByText("Unavailable"));
  for (const word of ["Connected", "Registration needs repair", "damaged", "duplicate"])
    assert.equal(ui.container.textContent!.includes(word), false, word);
});

test("Home: a ready workspace whose folder was renamed still shows location details, with the registered name", async () => {
  const f = await healthyHome();
  const target = await f.home.getDirectory(["Engineering renamed"], { create: true });
  await copyVerifiedTree(await f.home.getDirectory(["Engineering"]), target);
  await f.home.removeEntry(["Engineering"], { recursive: true });
  const ui = render(<App />);
  await openTestHome(ui, f.home);
  const card = within(row(ui, "Engineering"));
  assert.ok(card.getByText("1 project · Ready"));
  assert.ok(card.getByText(/Location details/));
  assert.ok(card.getByText(/Registered as Engineering \(renamed or moved\)/));
});
