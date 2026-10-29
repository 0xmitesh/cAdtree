import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { ProjectConnectView } from "./ProjectConnectView";
import { scenarioState } from "../../tests/history-data";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import {
  ChangesCaptureView,
  type ChangesCaptureViewProps,
} from "./ChangesCaptureView";
import { historyState } from "../../tests/history-data";
import type { ScanResult } from "../engine/types";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  initializeProjectVault,
  openExistingVault,
} from "../engine/vault-service";
import { scanBranchChanges } from "../engine/scanner";
import { captureRevision, ReviewStaleError } from "../engine/revision-service";
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "../engine/recovery-service";

afterEach(cleanup);
test("branch highlighting and zoom controls change only viewing state", () => {
  const state = scenarioState("branches");
  const before = JSON.stringify(state);
  const ui = render(
    <HistoryRecoveryView {...historyProps({ vaultState: state })} />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Prototype" }));
  assert.equal(
    ui.getByRole("button", { name: "Prototype" }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(JSON.stringify(state), before);
  fireEvent.click(ui.getByRole("button", { name: "Zoom in" }));
  assert.ok(ui.getByText("110%"));
  fireEvent.click(
    ui.getByRole("button", { name: "Fit graph width and reset scroll" }),
  );
  assert.ok(ui.getByText("80%")); // jsdom clientWidth is zero; zoom is bounded.
});
test("project setup is focused and forgetting a project removes only its remembered entry", async () => {
  const removed: string[] = [];
  const ui = render(
    <ProjectConnectView
      rememberedBindings={[
        {
          projectId: "p",
          projectName: "Actuator",
          lastOpenedAt: "2026-10-29T12:00:00Z",
          vaultFolderName: "Vault",
          branchWorkingHandles: {},
          workingFolderNames: {},
        },
      ]}
      onCreateRealProject={async () => {}}
      onOpenRealVault={async () => {}}
      onReconnectRemembered={async () => {}}
      onRemoveRemembered={async (id) => {
        removed.push(id);
      }}
      onClearAllConvenienceMetadata={async () => {}}
    />,
  );
  assert.equal(ui.queryByRole("dialog"), null);
  fireEvent.click(ui.getByRole("button", { name: "New project" }));
  assert.ok(ui.getByRole("dialog", { name: "New project" }));
  assert.ok(ui.getByRole("textbox", { name: "Project name" }));
  assert.equal(ui.queryByRole("button", { name: "Open project" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  fireEvent.click(ui.getByRole("button", { name: "Forget" }));
  assert.equal(removed.length, 0);
  assert.ok(
    ui.getByText(/Your CAD files and saved revisions stay in their folders/),
  );
  fireEvent.click(ui.getByRole("button", { name: "Forget project" }));
  await waitFor(() => assert.deepEqual(removed, ["p"]));
});
const noop = async () => {};
test("recovery review sends the exact snapshot and selected paths to the existing engine", async () => {
  const disk = new InMemoryFileSystemAdapter("recovery-ui");
  const working = await disk.getDirectory(["Working"], { create: true });
  const vault = await disk.getDirectory(["Vault"], { create: true });
  await working.writeFileBytes(
    ["Housing.SLDPRT"],
    new Uint8Array([0, 255, 2, 3]),
  );
  await working.writeFileBytes(["Shaft.SLDPRT"], new Uint8Array([4, 5, 6]));
  await initializeProjectVault(working, vault, "Recovery UI");
  const captured = await captureRevision(working, vault, {
    branchId: "branch-main",
    summary: "Verified baseline",
    notes: { problem: "", modification: "", observations: "" },
  });
  const fullDestination = await disk.getDirectory(["FullCopy"], {
    create: true,
  });
  const selectedDestination = await disk.getDirectory(["SelectedCopy"], {
    create: true,
  });
  const results: any[] = [];
  const ui = render(
    <HistoryRecoveryView
      {...historyProps({
        vaultState: captured.vaultState,
        onRestoreFullProject: async (revisionId) => {
          results.push(
            await restoreRevisionToFolder({
              vaultDir: vault,
              workingDir: working,
              destinationDir: fullDestination,
              revisionId,
            }),
          );
        },
        onRestoreSelectedFiles: async (revisionId, selectedPaths) => {
          results.push(
            await restoreSelectedFilesToFolder({
              vaultDir: vault,
              workingDir: working,
              destinationDir: selectedDestination,
              revisionId,
              selectedPaths,
            }),
          );
        },
      })}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  assert.equal(results.length, 0);
  fireEvent.click(ui.getByRole("button", { name: "Choose destination" }));
  await waitFor(() => assert.equal(results.length, 1));
  assert.equal(results[0].restoredFilesCount, 2);
  fireEvent.click(
    ui.getByRole("checkbox", { name: "Select Housing.SLDPRT for recovery" }),
  );
  fireEvent.click(ui.getByRole("button", { name: "Copy selected files (1)" }));
  fireEvent.click(ui.getByRole("button", { name: "Choose destination" }));
  await waitFor(() => assert.equal(results.length, 2));
  assert.equal(results[1].kind, "selected_files");
  assert.deepEqual(
    [...(await selectedDestination.readFileBytes(["Housing.SLDPRT"]))],
    [0, 255, 2, 3],
  );
  assert.equal(await selectedDestination.hasFile(["Shaft.SLDPRT"]), false);
  assert.deepEqual(
    [...(await working.readFileBytes(["Housing.SLDPRT"]))],
    [0, 255, 2, 3],
  );
});
function historyProps(
  overrides: Partial<HistoryRecoveryViewProps> = {},
): HistoryRecoveryViewProps {
  return {
    vaultState: historyState(2),
    activeBranchId: "branch-main",
    isRestoring: false,
    progress: null,
    lastRestoreReport: null,
    statusBanner: null,
    onRestoreFullProject: noop,
    onRestoreSelectedFiles: noop,
    onVerifySingleRevisionObjects: noop,
    onCancelOperation: () => {},
    ...overrides,
  };
}
test("graph selection, keyboard, and list mode share one immutable inspection state", () => {
  const props = historyProps();
  const before = JSON.stringify(props.vaultState);
  const ui = render(<HistoryRecoveryView {...props} />);
  const baseline = ui.getByRole("button", { name: /Rev 001: Initial/ });
  fireEvent.click(baseline);
  assert.ok(ui.getByRole("heading", { name: "Initial baseline" }));
  fireEvent.keyDown(baseline, { key: "ArrowUp" });
  assert.equal(
    ui
      .getByRole("button", { name: /Rev 002: Refine/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  assert.ok(ui.getByRole("heading", { name: "Refine housing clearance" }));
  fireEvent.click(ui.getByRole("button", { name: "Graph" }));
  assert.equal(
    ui
      .getByRole("button", { name: /Rev 002: Refine/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(JSON.stringify(props.vaultState), before);
});
test("both recovery entry points disclose revision and file count before destination selection", async () => {
  const full: string[] = [];
  const partial: { id: string; paths: string[] }[] = [];
  const ui = render(
    <HistoryRecoveryView
      {...historyProps({
        onRestoreFullProject: async (id) => {
          full.push(id);
        },
        onRestoreSelectedFiles: async (id, paths) => {
          partial.push({ id, paths });
        },
      })}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  assert.equal(full.length, 0);
  assert.ok(ui.getByText("5 files · Complete project snapshot"));
  fireEvent.click(ui.getByRole("button", { name: "Choose destination" }));
  await waitFor(() => assert.deepEqual(full, ["r2"]));
  fireEvent.click(
    ui.getByRole("checkbox", {
      name: "Select Parts/Housing.SLDPRT for recovery",
    }),
  );
  fireEvent.click(ui.getByRole("button", { name: "Copy selected files (1)" }));
  assert.equal(partial.length, 0);
  assert.ok(ui.getByText("1 file · Selected-file copy"));
  fireEvent.click(ui.getByRole("button", { name: "Choose destination" }));
  await waitFor(() =>
    assert.deepEqual(partial, [{ id: "r2", paths: ["Parts/Housing.SLDPRT"] }]),
  );
});
test("unchanged files are available; deleted files can only be recovered from their earlier snapshot", () => {
  const state = historyState(2);
  state.revisions[1].manifest.files = state.revisions[1].manifest.files.filter(
    (f) => f.path !== "Parts/Output_shaft.SLDPRT",
  );
  const ui = render(
    <HistoryRecoveryView {...historyProps({ vaultState: state })} />,
  );
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: "Select Parts/Output_shaft.SLDPRT for recovery",
      }) as HTMLInputElement
    ).disabled,
    true,
  );
  assert.equal(
    ui.queryByRole("checkbox", { name: "Select Actuator.SLDASM for recovery" }),
    null,
  );
  fireEvent.click(ui.getByRole("button", { name: /Show .* unchanged files/ }));
  assert.ok(
    ui.getByRole("checkbox", { name: "Select Actuator.SLDASM for recovery" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /View in parent revision/ }));
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: "Select Parts/Output_shaft.SLDPRT for recovery",
      }) as HTMLInputElement
    ).checked,
    true,
  );
  assert.ok(ui.getByRole("heading", { name: "Initial baseline" }));
});
test("damaged records stay visible and block recovery; metadata does not claim content verification", () => {
  const props = historyProps();
  props.vaultState.revisions[1].integrityStatus = "corrupted";
  const ui = render(<HistoryRecoveryView {...props} />);
  assert.ok(ui.getByText("Damaged revision · recovery blocked"));
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Restore project copy",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  fireEvent.click(ui.getByRole("button", { name: /Rev 001: Initial/ }));
  assert.ok(ui.getByText("Metadata verified · contents not yet checked"));
});
const scan: ScanResult = {
  scannedAt: "2026-10-29T12:00:00Z",
  branchId: "branch-main",
  baselineRevisionId: "r1",
  baselineDisplayNumber: 1,
  added: [
    { path: "New.SLDPRT", size: 10, sha256: "b".repeat(64), lastModified: 0 },
  ],
  modified: [],
  deleted: [],
  unchanged: [
    {
      path: "Unchanged.SLDPRT",
      size: 10,
      sha256: "a".repeat(64),
      lastModified: 0,
    },
  ],
  directories: [],
  addedDirectories: [],
  deletedDirectories: [],
  errors: [],
  hasChanges: true,
  canCapture: true,
  totalBytes: 20,
  changesSignature: "reviewed",
};
function changesProps(
  overrides: Partial<ChangesCaptureViewProps> = {},
): ChangesCaptureViewProps {
  return {
    vaultState: historyState(1),
    activeBranchId: "branch-main",
    workingFolderName: "CAD working",
    vaultFolderName: "Vault",
    scanResult: scan,
    isScanStale: false,
    isScanning: false,
    isCapturing: false,
    progress: null,
    statusBanner: null,
    onScan: noop,
    onCapture: noop,
    onCancelOperation: () => {},
    onReattachWorkingFolder: noop,
    ...overrides,
  };
}
test("capture uses the reviewed signature and scoped notes; drafts survive view hiding and changed selection", async () => {
  const calls: any[] = [];
  const props = changesProps({
    onCapture: async (p) => {
      calls.push(p);
      throw new Error("Save blocked");
    },
  });
  const ui = render(
    <div>
      <ChangesCaptureView {...props} />
    </div>,
  );
  assert.equal(ui.queryByText("Unchanged.SLDPRT"), null);
  fireEvent.change(ui.getByPlaceholderText("e.g. Refine housing clearance"), {
    target: { value: "Add retainer" },
  });
  fireEvent.click(ui.getByRole("button", { name: "Add note for New.SLDPRT" }));
  fireEvent.change(ui.getByRole("textbox", { name: "New.SLDPRT: problem" }), {
    target: { value: "Improve retention" },
  });
  ui.rerender(
    <div hidden>
      <ChangesCaptureView {...props} />
    </div>,
  );
  ui.rerender(
    <div>
      <ChangesCaptureView {...props} />
    </div>,
  );
  assert.equal(
    (
      ui.getByRole("textbox", {
        name: "New.SLDPRT: problem",
      }) as HTMLTextAreaElement
    ).value,
    "Improve retention",
  );
  fireEvent.submit(
    ui.getByRole("button", { name: "Save revision" }).closest("form")!,
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].reviewedChangesSignature, "reviewed");
  assert.deepEqual(calls[0].fileNotes, [
    {
      path: "New.SLDPRT",
      problem: "Improve retention",
      modification: "",
      observations: "",
    },
  ]);
  assert.equal(
    (
      ui.getByPlaceholderText(
        "e.g. Refine housing clearance",
      ) as HTMLInputElement
    ).value,
    "Add retainer",
  );
});
test("capture rescan integration keeps draft, blocks stale review, and publishes only after explicit re-review", async () => {
  const disk = new InMemoryFileSystemAdapter("ui-test");
  const working = await disk.getDirectory(["Working"], { create: true });
  const vault = await disk.getDirectory(["Vault"], { create: true });
  await working.writeFileBytes(["Part.SLDPRT"], new Uint8Array([1, 2, 3]));
  const state = await initializeProjectVault(working, vault, "UI test");
  const firstScan = await scanBranchChanges(working, "branch-main", null);
  await working.writeFileBytes(["Late.SLDPRT"], new Uint8Array([4, 5, 6]));
  function Harness() {
    const [review, setReview] = useState(firstScan);
    return (
      <ChangesCaptureView
        {...changesProps({
          vaultState: state,
          scanResult: review,
          onCapture: async (input) => {
            try {
              await captureRevision(working, vault, {
                branchId: "branch-main",
                ...input,
              });
            } catch (e) {
              if (e instanceof ReviewStaleError) setReview(e.freshScan);
              throw e;
            }
          },
        })}
      />
    );
  }
  const ui = render(<Harness />);
  fireEvent.change(ui.getByPlaceholderText("e.g. Refine housing clearance"), {
    target: { value: "Initial complete project" },
  });
  fireEvent.submit(
    ui.getByRole("button", { name: "Save revision" }).closest("form")!,
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "confirm this file set" })),
  );
  assert.equal((await openExistingVault(vault)).revisions.length, 0);
  assert.equal(
    (ui.getByRole("button", { name: "Save revision" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  assert.equal(
    (
      ui.getByPlaceholderText(
        "e.g. Refine housing clearance",
      ) as HTMLInputElement
    ).value,
    "Initial complete project",
  );
  fireEvent.click(ui.getByRole("button", { name: "confirm this file set" }));
  fireEvent.submit(
    ui.getByRole("button", { name: "Save revision" }).closest("form")!,
  );
  await waitFor(() =>
    assert.equal(
      (
        ui.getByPlaceholderText(
          "e.g. Refine housing clearance",
        ) as HTMLInputElement
      ).value,
      "",
    ),
  );
  assert.equal(
    (await openExistingVault(vault)).revisions[0].manifest.files.length,
    2,
  );
});
