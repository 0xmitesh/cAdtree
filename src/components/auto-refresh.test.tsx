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
import { autoRefreshTiming } from "../app/useAutoRefresh";
import { ChangesCaptureView } from "./ChangesCaptureView";
import { scenarioState } from "../../tests/history-data";
import { knownHashesFor } from "../engine/scanner";
import type { ScanResult } from "../engine/types";

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

test("Copy files saves by itself; the quiet rescan then shows no changes and Undo opens Bring back", async () => {
  const { sample, ui, nav } = await openSample();
  fireEvent.click(nav.getByRole("button", { name: "History" }));
  fireEvent.click(await ui.findByRole("button", { name: /Reinforced mounting rib/ }));
  fireEvent.click(ui.getByRole("button", { name: /^Copy files from .*…$/ }));
  const copy = within(await ui.findByRole("dialog", { name: /^Copy files from / }));
  for (const radio of copy.queryAllByRole("radio", { name: /^Take theirs/ })) fireEvent.click(radio);
  const rib = copy.getByRole("checkbox", { name: /^Copy .*Rib\.SLDPRT$/ });
  if (!(rib as HTMLInputElement).checked) fireEvent.click(rib);
  fireEvent.change(copy.getByRole("textbox", { name: "Why (optional)" }), { target: { value: "Reuse the rib from the lightweight study" } });
  fireEvent.click(copy.getByRole("button", { name: "Copy files" }));
  const banner = await waitFor(() => {
    const text = document.body.textContent!;
    assert.match(text, /Saved as V\d+\. To undo, bring back V\d+\./);
    return text;
  }, { timeout: 5000 });
  assert.ok(await sample.main.hasFile(["Rib.SLDPRT"]));
  assert.equal(ui.queryByRole("dialog", { name: /^Copy files from / }), null);
  const previous = banner.match(/bring back (V\d+)\./)![1];
  fireEvent.click(ui.getByRole("button", { name: "Undo" }));
  assert.ok(await ui.findByRole("dialog", { name: `Bring back ${previous} onto Main` }));
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  // Nothing clicked: the quiet rescan shows the folder matches the new revision.
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  await waitFor(() => assert.match(document.body.textContent!, /No changes since V\d+/), { timeout: 5000 });
  assert.equal(ui.queryByRole("button", { name: "Scan for changes" }), null);
});

test("the Scan for changes button is gone; the Changes page shows its state as text", async () => {
  const { ui } = await openSample();
  assert.equal(ui.queryByRole("button", { name: /Scan for changes|Scanning/ }), null);
  assert.match(ui.container.querySelector("[data-scanned-at]")!.textContent!, /Scanned/);
});

test("a version draft survives a quiet rescan", async () => {
  const { sample, ui } = await openSample();
  await sample.main.writeFileText(["Draft-file.txt"], "one");
  await waitForScan(ui);
  fireEvent.change(ui.getByRole("textbox", { name: /Version summary/ }), { target: { value: "My unsaved draft" } });
  await sample.main.writeFileText(["Draft-file.txt"], "two, longer");
  await waitForScan(ui);
  assert.equal((ui.getByRole("textbox", { name: /Version summary/ }) as HTMLInputElement).value, "My unsaved draft");
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
  assert.equal(ui.queryByRole("button", { name: /Refresh workspace/ }), null);
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
  assert.equal(ui.queryByRole("button", { name: /Refresh home/ }), null);
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

test("a focus soon after the last run is postponed to the end of the interval, not dropped", async () => {
  const { sample, ui } = await openSample();
  const saved = autoRefreshTiming.minIntervalMs;
  autoRefreshTiming.minIntervalMs = 600;
  try {
    await waitForScan(ui);
    const first = scannedAt(ui);
    await sample.main.writeFileText(["Postponed.txt"], "later");
    await focusWindow();
    await sleep(200);
    assert.equal(scannedAt(ui), first, "still inside the interval: nothing has run yet");
    assert.equal(ui.queryByText("Postponed.txt"), null);
    await waitFor(() => assert.ok(ui.getByText("Postponed.txt")), { timeout: 3000 });
  } finally {
    autoRefreshTiming.minIntervalMs = saved;
  }
});

test("a check that cannot read the folder marks the result as not up to date, quietly, with a Retry that works", async () => {
  const { sample, ui } = await openSample();
  sample.home.setHooks({ readPermission: "prompt" });
  await focusWindow();
  await waitFor(() => assert.ok(ui.getByTestId("check-failed")));
  assert.match(ui.container.querySelector("[data-scanned-at]")!.textContent!, /Not up to date/);
  assert.doesNotMatch(ui.container.querySelector("[data-scanned-at]")!.textContent!, /Latest scan/);
  assert.equal(ui.container.querySelector("[role='alert']"), null, "no banner for a background check");
  sample.home.setHooks({ readPermission: "granted" });
  const before = scannedAt(ui);
  fireEvent.click(within(ui.getByTestId("check-failed")).getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.notEqual(scannedAt(ui), before));
  await waitFor(() => assert.equal(ui.queryByTestId("check-failed"), null));
});

test("with no result yet, a failed check says so and offers Retry instead of 'Scan needed'", () => {
  let retried = 0;
  const ui = render(
    <ChangesCaptureView
      vaultState={scenarioState("single")}
      activeBranchId="branch-main"
      workingFolderName="CAD working"
      vaultFolderName="Vault"
      scanResult={null}
      isScanStale={false}
      isScanning={false}
      isChecking={false}
      checkFailed
      isCapturing={false}
      progress={null}
      statusBanner={null}
      onScan={async () => { retried++; }}
      onCapture={async () => {}}
      onCancelOperation={() => {}}
      onReattachWorkingFolder={async () => {}}
    />,
  );
  assert.equal(ui.queryByText(/Scan needed/), null);
  assert.ok(ui.getByText(/Couldn't check files/));
  fireEvent.click(ui.getByRole("button", { name: "Retry" }));
  assert.equal(retried, 1);
});

test("the hash cache is never used across cases", () => {
  const file = { path: "a.txt", size: 1, sha256: "x", lastModified: 1000 };
  const previous = {
    scannedAt: new Date(100_000).toISOString(),
    branchId: "case-A",
    added: [file],
    modified: [],
    unchanged: [],
  } as unknown as ScanResult;
  assert.equal(knownHashesFor(previous, "case-B"), undefined);
  assert.equal(knownHashesFor(null, "case-A"), undefined);
  assert.deepEqual([...knownHashesFor(previous, "case-A")!.keys()], ["a.txt"]);
});
