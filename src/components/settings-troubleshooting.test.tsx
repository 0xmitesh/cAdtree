import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { resolveManagedProject } from "../engine/workspace-service";
import type { VaultState } from "../engine/types";
import { DiagnosticsView, type DiagnosticsViewProps } from "./DiagnosticsView";

Object.assign(globalThis, { indexedDB });
afterEach(cleanup);

async function sampleState(): Promise<VaultState> {
  const sample = await compareApplyRecoverSample();
  return (await resolveManagedProject(sample.workspace.root, sample.project.record.containerPath)).vaultState;
}
const noop = async () => {};
function view(state: VaultState, props: Partial<DiagnosticsViewProps> = {}) {
  return render(
    <DiagnosticsView
      vaultState={state}
      isVerifyingAll={false}
      onVerifyAllObjects={noop}
      onResetConnections={noop}
      workingFolderName="working/main"
      vaultFolderName="vault"
      onReattachWorkingFolder={noop}
      managed
      missingConnections={[]}
      {...props}
    />,
  );
}
const troubleshooting = (ui: ReturnType<typeof view>) =>
  ui.container.querySelector<HTMLDetailsElement>("details.settings-troubleshooting")!;

test("Settings with everything connected shows one status line and a closed Troubleshooting section", async () => {
  const ui = view(await sampleState());
  assert.ok(ui.getByText("All folders are connected."));
  assert.equal(troubleshooting(ui).open, false);
  assert.equal(troubleshooting(ui).querySelector("summary")!.textContent, "Troubleshooting");
  assert.equal(ui.queryByText(/Something needs attention/), null);
  // Folder rows, verification, records and reset all live inside the one section.
  const inside = within(troubleshooting(ui));
  for (const name of ["Reconnect workspace", "Verify all file contents", "Reset all remembered folder connections in this browser"])
    assert.ok(inside.getByRole("button", { name }), name);
  assert.ok(inside.getByText("Advanced record information"));
  assert.ok(inside.getByText(/Unfinished attempts/));
  assert.ok(inside.getByText("Case records"));
  assert.equal(ui.container.querySelectorAll("details.settings-troubleshooting").length, 1);
  // The working folder row stays visible outside Troubleshooting (its Copy path button needs the path-shortcuts provider; see path-shortcuts.test).
  assert.equal(troubleshooting(ui).contains(ui.getByText("working/main")), false);
  assert.equal(ui.container.querySelectorAll(".settings-page > .panel > details").length, 1);
});

test("A missing working folder shows the folder rows above Troubleshooting instead of the status line", async () => {
  const ui = view(await sampleState(), { missingConnections: ["Lightweight bracket"] });
  assert.equal(ui.queryByText("All folders are connected."), null);
  const button = ui.getByRole("button", { name: "Reconnect workspace" });
  assert.equal(troubleshooting(ui).contains(button), false);
  assert.ok(ui.getByText("working/main"));
  // The rows are not repeated inside Troubleshooting.
  assert.equal(ui.getAllByRole("button", { name: "Reconnect workspace" }).length, 1);
  const unmanaged = view(await sampleState(), { managed: false, workingFolderName: null });
  assert.ok(unmanaged.getByRole("button", { name: "Connect folder" }));
  assert.equal(unmanaged.queryByText("All folders are connected."), null);
});

test("Incomplete attempts and damaged records show a hint that opens Troubleshooting", async () => {
  const state = await sampleState();
  const ui = view({ ...state, incompleteAttempts: [{ path: "staging/attempt-1", detail: "Interrupted save" }] as VaultState["incompleteAttempts"] });
  assert.equal(troubleshooting(ui).open, false);
  assert.ok(ui.getByText(/Something needs attention/));
  fireEvent.click(ui.getByRole("button", { name: "open Troubleshooting" }));
  assert.equal(troubleshooting(ui).open, true);
  assert.equal(document.activeElement, troubleshooting(ui).querySelector("summary"));
  assert.ok(ui.getByText("staging/attempt-1"));
  const damaged = view({ ...state, corruptedRecords: [{ recordPath: "vault/revisions/x", reason: "Bad checksum" }] as VaultState["corruptedRecords"] });
  assert.ok(damaged.getAllByText(/Something needs attention/).length >= 1);
  assert.ok(damaged.getByText("Bad checksum"));
});
