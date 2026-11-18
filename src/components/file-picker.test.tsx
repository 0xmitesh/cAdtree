import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { historyState } from "../../tests/history-data";
import {
  filePicker,
  pickFile,
  pickerOptions,
  showAllFiles,
} from "../../tests/file-picker";
import type { VaultState } from "../engine/types";
afterEach(cleanup);

const actuatorId = "component-11111111-1111-4111-8111-111111111111";
const housingId = "component-22222222-2222-4222-8222-222222222222";
const oldHousing = "Parts/Housing.SLDPRT";
const newHousing = "Parts/Housing_v2.SLDPRT";

function props(vaultState: VaultState): HistoryRecoveryViewProps {
  return {
    vaultState,
    activeBranchId: "branch-main",
    progress: null,
    statusBanner: null,
    onVerifySingleRevisionObjects: async () => {},
    onCancelOperation: () => {},
  };
}
/** Three revisions; the housing is tracked as one component and renamed in r2. The other files are untracked. */
function trackedState(): VaultState {
  const state = historyState(3);
  state.revisions.slice(1).forEach((r) => {
    r.manifest.files.find((f) => f.path === oldHousing)!.path = newHousing;
  });
  state.components = {
    status: "available",
    revisions: Object.fromEntries(
      state.revisions.map((r) => [
        r.manifest.revisionId,
        {
          payloadSha256: "f".repeat(64),
          renames: [],
          files: [
            { path: "Actuator.SLDASM", componentId: actuatorId },
            {
              path: r.manifest.displayNumber > 1 ? newHousing : oldHousing,
              componentId: housingId,
            },
          ],
        },
      ]),
    ),
  };
  return state;
}
const open = (ui: ReturnType<typeof render>) =>
  fireEvent.focus(filePicker(ui));

test("a tracked file is listed once under its latest name, without an ID suffix or group headings", () => {
  const ui = render(<HistoryRecoveryView {...props(trackedState())} />);
  open(ui);
  const options = pickerOptions(ui);
  assert.equal(options.filter((o) => o === "Actuator.SLDASM").length, 1);
  assert.deepEqual(options, [
    "All files",
    "Actuator.SLDASM",
    "Drawings/Actuator.SLDDRW",
    "Parts/Bearing_retainer.SLDPRT",
    newHousing,
    "Parts/Output_shaft.SLDPRT",
  ]);
  assert.ok(!options.some((o) => o.includes("·") || o.includes(oldHousing)));
  assert.equal(ui.container.querySelector("select, optgroup"), null);
  assert.doesNotMatch(ui.container.textContent!, /confirmed identity|no identity inferred/i);
});

test("a path no component covers is listed once, and selecting it says renames are not followed", () => {
  const ui = render(<HistoryRecoveryView {...props(trackedState())} />);
  open(ui);
  assert.equal(pickerOptions(ui).filter((o) => o === "Parts/Output_shaft.SLDPRT").length, 1);
  fireEvent.blur(filePicker(ui));
  pickFile(ui, "Parts/Output_shaft.SLDPRT");
  assert.equal(filePicker(ui).value, "Parts/Output_shaft.SLDPRT");
  assert.ok(ui.getByText("Renames are not followed for this file."));
});

test("a renamed component appears once under its latest name and its history continues across the rename", () => {
  const ui = render(<HistoryRecoveryView {...props(trackedState())} />);
  open(ui);
  const options = pickerOptions(ui);
  assert.equal(options.filter((o) => o.includes("Housing")).length, 1);
  fireEvent.blur(filePicker(ui));
  pickFile(ui, newHousing);
  assert.equal(filePicker(ui).value, newHousing);
  assert.equal(ui.queryByText("Renames are not followed for this file."), null);
  assert.equal(
    ui.container.querySelectorAll('.graph-row[data-file-history-kind="change"]').length,
    3,
  );
  fireEvent.click(ui.getByRole("button", { name: /Rev 002:/ }));
  const details = ui.getByRole("region", { name: "Selected file history" }).textContent!;
  assert.match(details, /Renamed/);
  assert.ok(details.includes(oldHousing));
});

test("typing filters the list case-insensitively; keyboard picks, Escape cancels, and a button returns to all files", () => {
  const ui = render(<HistoryRecoveryView {...props(trackedState())} />);
  const input = filePicker(ui);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "OUTPUT" } });
  assert.deepEqual(pickerOptions(ui), ["Parts/Output_shaft.SLDPRT"]);
  fireEvent.change(input, { target: { value: "parts/" } });
  assert.deepEqual(pickerOptions(ui), ["Parts/Bearing_retainer.SLDPRT", newHousing, "Parts/Output_shaft.SLDPRT"]);
  fireEvent.change(input, { target: { value: "no such file" } });
  assert.equal(ui.queryByRole("listbox"), null);
  assert.ok(ui.getByText("No files match."));
  // Escape abandons the typed text and leaves the selection unchanged.
  fireEvent.keyDown(input, { key: "Escape" });
  assert.equal(input.value, "");
  assert.equal(ui.queryByText("No files match."), null);
  // Arrow keys move through the filtered list; Enter picks.
  fireEvent.change(input, { target: { value: "parts/" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  assert.equal(
    input.getAttribute("aria-activedescendant"),
    ui.getByRole("option", { name: newHousing }).id,
  );
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(input.value, newHousing);
  assert.equal(ui.queryByRole("listbox"), null);
  showAllFiles(ui);
  assert.equal(input.value, "");
  assert.equal(ui.queryByRole("button", { name: "Show all files" }), null);
  assert.equal(ui.container.querySelectorAll(".graph-row").length, 3);
});

test("when component evidence is unreadable, every path is listed once and the error stays visible", () => {
  const state = trackedState();
  state.components = {
    status: "unavailable",
    reason: "Component identity unavailable: damaged record.",
    revisions: {},
  };
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  assert.ok(ui.getByRole("alert").textContent!.includes("damaged record"));
  open(ui);
  assert.deepEqual(pickerOptions(ui), [
    "All files",
    "Actuator.SLDASM",
    "Drawings/Actuator.SLDDRW",
    "Parts/Bearing_retainer.SLDPRT",
    newHousing,
    oldHousing,
    "Parts/Output_shaft.SLDPRT",
  ]);
});
