import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, scannedAt, selectBranch, waitForScan } from "../../tests/app-controls";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { createProject } from "../engine/workspace-service";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

const focusWindow = () => act(async () => { window.dispatchEvent(new window.Event("focus")); });
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function openSample() {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  const nav = within(ui.getByRole("navigation", { name: "Primary navigation" }));
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  await waitFor(() => assert.ok(scannedAt(ui)));
  return { sample, ui, nav };
}

/** Holds the next listing of the working folder `main` until released; counts every such listing. */
function gateMainListing(sample: { home: { setHooks: (hooks: { onBeforeListEntries: (path: string) => Promise<void> }) => void } }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = { listings: 0, armed: true };
  sample.home.setHooks({
    onBeforeListEntries: async (path: string) => {
      if (!path.endsWith("working/main")) return;
      state.listings++;
      if (state.armed) {
        state.armed = false;
        await gate;
      }
    },
  });
  return { state, release: () => release() };
}

test("returning to the window rescans the case quietly: no busy state, no banner, the old result stays until the new one arrives", async () => {
  const { sample, ui } = await openSample();
  const first = scannedAt(ui);
  await sample.main.writeFileText(["Added-outside.txt"], "new");
  const gate = gateMainListing(sample);
  await focusWindow();
  await waitFor(() => assert.ok(ui.getByTestId("auto-check")));
  assert.equal(appBusy(ui), false);
  assert.equal(ui.container.querySelector(".status-banner, [role='status']")?.textContent?.includes("Scan complete") ?? false, false);
  assert.equal(scannedAt(ui), first, "the old result stays on screen while checking");
  assert.equal(ui.queryByText("Added-outside.txt"), null);
  gate.release();
  await waitFor(() => assert.ok(ui.getByText("Added-outside.txt")));
  await waitFor(() => assert.equal(ui.queryByTestId("auto-check"), null));
  assert.notEqual(scannedAt(ui), first);
  assert.equal(ui.queryByText(/Scan complete/), null);
  assert.equal(appBusy(ui), false);
});

test("a tab that becomes visible rescans too", async () => {
  const { sample, ui } = await openSample();
  await sample.main.writeFileText(["Seen-after-tab-switch.txt"], "new");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await waitFor(() => assert.ok(ui.getByText("Seen-after-tab-switch.txt")));
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a tab that is hidden does not rescan", async () => {
  const { sample, ui } = await openSample();
  const before = scannedAt(ui);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await sleep(150);
    assert.equal(scannedAt(ui), before);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
  assert.ok(sample);
});

test("an operation the user starts during a quiet scan cancels it and runs; the dropped scan shows nothing", async () => {
  const { sample, ui } = await openSample();
  const gate = gateMainListing(sample);
  await focusWindow();
  await waitFor(() => assert.ok(ui.getByTestId("auto-check")));
  assert.equal(gate.state.listings, 1);
  // Switching case is a user operation: it must not be refused because the quiet scan is running.
  await selectBranch(ui, sample.caseId);
  assert.equal(currentBranchId(ui), sample.caseId);
  assert.equal(ui.queryByTestId("auto-check"), null);
  gate.release();
  await sleep(100);
  assert.equal(currentBranchId(ui), sample.caseId);
  assert.equal(ui.container.querySelector("[role='alert']"), null, "the cancelled scan reports nothing");
  assert.equal(ui.queryByText(/cancel/i), null);
});

test("no quiet scan starts while an operation runs or a dialog is open", async () => {
  const { sample, ui, nav } = await openSample();
  fireEvent.click(ui.getByRole("button", { name: /Learn cAdtree/ }));
  await waitFor(() => assert.ok(document.querySelector("dialog[open]")));
  const gate = gateMainListing(sample);
  gate.state.armed = false;
  await focusWindow();
  await sleep(400);
  assert.equal(gate.state.listings, 0, "a dialog is open");
  fireEvent.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => assert.equal(document.querySelector("dialog[open]"), null));
  // A user operation that is still running (switching case, held open) also blocks it.
  gate.state.armed = true;
  fireEvent.click(ui.container.querySelector<HTMLElement>(`.desktop-workspace-tree [role="treeitem"][data-branch-id="${sample.caseId}"]`)!);
  await waitFor(() => assert.equal(appBusy(ui), true));
  gate.state.listings = 0;
  await focusWindow();
  await sleep(400);
  assert.equal(gate.state.listings, 0, "an operation is running");
  gate.release();
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.ok(nav);
});

test("Changes fills in by itself after Apply, even while the completion dialog is open", async () => {
  const { sample, ui, nav } = await openSample();
  const changes = () => within(ui.container.querySelector<HTMLElement>("[data-scanned-at]")!.closest<HTMLElement>(".changes-page")!);
  assert.equal(changes().queryByText("Rib.SLDPRT"), null);
  fireEvent.click(nav.getByRole("button", { name: "History" }));
  fireEvent.click(await ui.findByRole("button", { name: /Reinforced mounting rib/ }));
  fireEvent.click(ui.getByRole("button", { name: "Review changes to apply" }));
  const review = within(await ui.findByRole("dialog", { name: "Review changes to apply — preview" }));
  fireEvent.change(review.getByRole("textbox", { name: "Engineering reason for proposed application" }), { target: { value: "Reuse the rib from the lightweight study" } });
  const rib = review.getByRole("checkbox", { name: /Select source .*Rib\.SLDPRT/ });
  if (!(rib as HTMLInputElement).checked) fireEvent.click(rib);
  fireEvent.click(review.getByRole("button", { name: "Prepare application" }));
  const confirm = within(await ui.findByRole("dialog", { name: "Confirm working-file application" }));
  fireEvent.click(confirm.getByRole("checkbox", { name: /I have saved and closed relevant CAD documents/ }));
  fireEvent.click(confirm.getByRole("button", { name: "Apply confirmed changes" }));
  await ui.findByRole("dialog", { name: "Application completed" });
  assert.ok(await sample.main.hasFile(["Rib.SLDPRT"]));
  // Nothing clicked: the quiet rescan shows the applied file in Changes.
  await waitFor(() => assert.ok(changes().getByText("Rib.SLDPRT")), { timeout: 5000 });
  assert.equal(ui.queryByRole("button", { name: "Scan for changes" }), null);
});

test("a revision draft survives a quiet rescan", async () => {
  const { sample, ui } = await openSample();
  await sample.main.writeFileText(["Draft-file.txt"], "one");
  await waitForScan(ui);
  fireEvent.change(ui.getByRole("textbox", { name: /Revision summary/ }), { target: { value: "My unsaved draft" } });
  await sample.main.writeFileText(["Draft-file.txt"], "two, longer");
  await waitForScan(ui);
  assert.equal((ui.getByRole("textbox", { name: /Revision summary/ }) as HTMLInputElement).value, "My unsaved draft");
});

test("the quiet scan never asks for folder access", async () => {
  const { sample, ui } = await openSample();
  let requested = 0;
  for (const dir of [sample.home, sample.workspace.root, sample.main])
    dir.requestPermission = async () => { requested++; return "granted"; };
  await waitForScan(ui);
  assert.equal(requested, 0);
});

test("a quiet scan that cannot read the folder keeps the last result and reports nothing", async () => {
  const { sample, ui } = await openSample();
  const before = scannedAt(ui);
  sample.home.setHooks({ readPermission: "prompt" });
  await focusWindow();
  await sleep(300);
  assert.equal(scannedAt(ui), before);
  assert.equal(ui.container.querySelector("[role='alert']"), null);
  assert.equal(appBusy(ui), false);
});

test("the workspace page lists a new project after returning to the window", async () => {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  assert.equal(ui.queryByText("Added elsewhere"), null);
  await createProject(sample.workspace.root, "Added elsewhere");
  await focusWindow();
  await waitFor(() => assert.ok(ui.getByText("Added elsewhere")));
  assert.equal(appBusy(ui), false);
});

test("the home page lists a new workspace after returning to the window", async () => {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  const { openTestHome } = await import("../../tests/app-controls");
  await openTestHome(ui, sample.home);
  const { createHomeWorkspace } = await import("../engine/home-service");
  await createHomeWorkspace(sample.home, "Second Workspace");
  await focusWindow();
  await waitFor(() => assert.ok(ui.getAllByText("Second Workspace").length));
});

test("perform stops the quiet scan first", async () => {
  const { renderHook, act: hookAct } = await import("@testing-library/react");
  const { useOperation } = await import("../app/useOperation");
  const { result } = renderHook(() =>
    useOperation({
      activeTab: "changes",
    }),
  );
  const background = new AbortController();
  result.current.backgroundRef.current = background;
  await hookAct(async () => { await result.current.perform("scan", async () => {}); });
  assert.equal(background.signal.aborted, true);
});
