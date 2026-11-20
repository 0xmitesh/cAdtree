import "../../tests/dom";
import { pickFile } from "../../tests/file-picker";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { historyState, scenarioState } from "../../tests/history-data";
afterEach(cleanup);
const path = "Parts/Housing.SLDPRT";
const props = (
  overrides: Partial<HistoryRecoveryViewProps> = {},
): HistoryRecoveryViewProps => ({
  vaultState: historyState(4),
  activeBranchId: "branch-main",
  progress: null,
  statusBanner: null,
  onVerifySingleRevisionObjects: async () => {},
  onCancelOperation: () => {},
  ...overrides,
});

test("Compare initializes from the actual parent, swaps endpoints, compares nonadjacent and identical versions, and preserves History inspection", () => {
  const state = historyState(4),
    before = JSON.stringify(state);
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.equal(
    (
      dialog.getByRole("combobox", {
        name: "From version",
      }) as HTMLSelectElement
    ).value,
    "r3",
  );
  assert.equal(
    (dialog.getByRole("combobox", { name: "To version" }) as HTMLSelectElement)
      .value,
    "r4",
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "From version" }), {
    target: { value: "r1" },
  });
  assert.ok(dialog.getByRole("article", { name: `Modified: ${path}` }));
  fireEvent.click(dialog.getByRole("button", { name: "Swap" }));
  assert.equal(
    (
      dialog.getByRole("combobox", {
        name: "From version",
      }) as HTMLSelectElement
    ).value,
    "r4",
  );
  assert.equal(
    (dialog.getByRole("combobox", { name: "To version" }) as HTMLSelectElement)
      .value,
    "r1",
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "To version" }), {
    target: { value: "r4" },
  });
  assert.ok(
    dialog.getByText(
      "No file or directory differences between these saved snapshots.",
    ),
  );
  assert.equal(dialog.queryAllByRole("article").length, 0);
  fireEvent.click(
    dialog.getByRole("button", { name: "Show 5 unchanged files" }),
  );
  assert.equal(dialog.getAllByRole("article").length, 5);
  fireEvent.click(dialog.getByRole("button", { name: "Close comparison" }));
  assert.ok(
    ui
      .getByRole("button", { name: /V4:/ })
      .getAttribute("aria-pressed") === "true",
  );
  assert.equal(JSON.stringify(state), before);
});
test("Compare keeps checksums and component identity inside a closed Technical details disclosure", () => {
  const state = historyState(2);
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.equal(dialog.queryByText("Content hash"), null);
  const summary = dialog.getByText("Technical details");
  const disclosure = summary.closest("details") as HTMLDetailsElement;
  assert.ok(disclosure);
  assert.equal(disclosure.open, false);
  // Every checksum and the identity notes live only inside the disclosure.
  const codes = [...ui.getByRole("dialog").querySelectorAll("code")];
  assert.ok(codes.length > 0);
  assert.ok(codes.every((code) => disclosure.contains(code)));
  assert.ok(
    codes.some((code) =>
      state.revisions[1].manifest.files.some((f) => f.sha256 === code.textContent),
    ),
  );
  assert.equal(
    dialog.queryAllByText(/Component identity between endpoints/).filter(
      (element) => !disclosure.contains(element),
    ).length,
    0,
  );
  assert.ok(dialog.getByRole("article", { name: `Modified: ${path}` }));
});
test("file-scoped comparison expands to all files, labels endpoint notes and case names, and explains absence in both endpoints", () => {
  const state = scenarioState("branches");
  state.revisions[7].manifest.files = state.revisions[7].manifest.files.filter(
    (f) => f.path !== path,
  );
  state.revisions[0].manifest.files = state.revisions[0].manifest.files.filter(
    (f) => f.path !== path,
  );
  state.revisions[1].manifest.files = state.revisions[1].manifest.files.filter(
    (f) => f.path !== path,
  );
  state.revisions[5].manifest.fileNotes = [
    {
      path,
      problem: "Main endpoint note",
      modification: "Main bytes",
      observations: "Main only",
    },
  ];
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  pickFile(ui, path);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.ok(
    dialog
      .getByRole("group", { name: "Comparison scope" })
      .textContent?.includes(path),
  );
  assert.ok(dialog.getByText("Main endpoint note"));
  assert.ok(dialog.getByText("File notes at V6"));
  assert.ok(
    dialog.getByText(/Notes are recorded at the selected endpoints only/),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Show all files" }));
  assert.ok(dialog.getByText("Scope: All project files"));
  fireEvent.click(
    dialog.getByRole("button", { name: "Focus on selected file" }),
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "From version" }), {
    target: { value: "r1" },
  });
  fireEvent.change(dialog.getByRole("combobox", { name: "To version" }), {
    target: { value: "r2" },
  });
  assert.ok(dialog.getByText("The selected path is absent in both versions."));
  fireEvent.change(dialog.getByRole("combobox", { name: "To version" }), {
    target: { value: "p2" },
  });
  assert.ok(
    dialog
      .getByRole("combobox", { name: "To version" })
      .textContent?.includes("Prototype"),
  );
});
test("initial or unavailable parent asks for a baseline; corrupt, missing and ambiguous endpoint evidence never shows zero counts", () => {
  const state = historyState(2);
  state.revisions[1].manifest.parentRevisionId = "missing";
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.equal(
    (
      dialog.getByRole("combobox", {
        name: "From version",
      }) as HTMLSelectElement
    ).value,
    "",
  );
  assert.ok(dialog.getByText(/Choose a From version/));
  assert.equal(
    dialog.queryByRole("status", { name: "Comparison counts" }),
    null,
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "From version" }), {
    target: { value: "r1" },
  });
  assert.ok(dialog.getByRole("status", { name: "Comparison counts" }));
  const damaged = structuredClone(state);
  damaged.revisions[0].integrityStatus = "corrupted";
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: damaged })} />);
  assert.ok(dialog.getByText(/From version unavailable/));
  assert.equal(
    dialog.queryByRole("status", { name: "Comparison counts" }),
    null,
  );
  const missing = structuredClone(state);
  missing.revisions = missing.revisions.slice(1);
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: missing })} />);
  assert.ok(dialog.getByText(/From version unavailable/));
  const duplicate = structuredClone(state);
  duplicate.revisions.push(structuredClone(duplicate.revisions[0]));
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: duplicate })} />);
  assert.ok(dialog.getByText(/From version unavailable/));
  assert.equal(
    dialog.queryByRole("status", { name: "Comparison counts" }),
    null,
  );
});
test("a baseline version has no assumed From; switching projects closes and resets comparison state", () => {
  const initial = props({ vaultState: historyState(1) });
  const ui = render(<HistoryRecoveryView {...initial} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  assert.equal(
    (ui.getByRole("combobox", { name: "From version" }) as HTMLSelectElement)
      .value,
    "",
  );
  const next = historyState(2);
  next.project.projectId = "second";
  next.revisions.forEach((r) => {
    r.manifest.projectId = "second";
    r.completion.projectId = "second";
  });
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: next })} />);
  assert.equal(ui.queryByRole("dialog"), null);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  assert.equal(
    (ui.getByRole("combobox", { name: "From version" }) as HTMLSelectElement)
      .value,
    "r1",
  );
  assert.equal(
    (ui.getByRole("combobox", { name: "To version" }) as HTMLSelectElement)
      .value,
    "r2",
  );
});
test("comparison distinguishes metadata-only from previously verified contents and exposes a damaged To even before a From is chosen", () => {
  const state = historyState(2);
  state.revisions[0].integrityStatus = "objects_verified";
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.ok(dialog.getByText(/Metadata and file contents previously verified/));
  assert.ok(dialog.getByText(/Metadata verified · file contents not checked/));
  fireEvent.click(dialog.getByRole("button", { name: "Close comparison" }));
  const damaged = structuredClone(state);
  damaged.revisions[1].integrityStatus = "corrupted";
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: damaged })} />);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const unavailable = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  assert.equal(
    (
      unavailable.getByRole("combobox", {
        name: "From version",
      }) as HTMLSelectElement
    ).value,
    "",
  );
  assert.ok(unavailable.getByText(/To version unavailable/));
  assert.equal(
    unavailable.queryByRole("status", { name: "Comparison counts" }),
    null,
  );
});
test("comparison includes overall and individual notes in file scope, labels endpoints, swaps them, and explains missing overall notes", () => {
  const state = historyState(2);
  state.revisions[0].manifest.notes = {
    problem: "Overall baseline intent",
    modification: "Baseline project change",
    observations: "Baseline project observation",
  };
  state.revisions[1].manifest.notes = {
    problem: "Overall target intent",
    modification: "Target project change",
    observations: "Target project observation",
  };
  state.revisions[0].manifest.fileNotes = [
    {
      path,
      problem: "Baseline part note",
      modification: "Part before",
      observations: "Part baseline",
    },
  ];
  state.revisions[1].manifest.fileNotes = [
    {
      path,
      problem: "Target part note",
      modification: "Part after",
      observations: "Part target",
    },
  ];
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  pickFile(ui, path);
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  const dialog = within(
    ui.getByRole("dialog", { name: "Compare saved versions" }),
  );
  const before = dialog.getByRole("region", {
    name: "From overall notes at V1",
  });
  const after = dialog.getByRole("region", {
    name: "To overall notes at V2",
  });
  assert.ok(before.textContent?.includes("Overall baseline intent"));
  assert.ok(before.textContent?.includes("Baseline project change"));
  assert.ok(before.textContent?.includes("Baseline project observation"));
  assert.ok(after.textContent?.includes("Overall target intent"));
  assert.ok(dialog.getByText("Baseline part note"));
  assert.ok(dialog.getByText("Target part note"));
  fireEvent.click(dialog.getByRole("button", { name: "Swap" }));
  assert.ok(
    dialog
      .getByRole("region", { name: "From overall notes at V2" })
      .textContent?.includes("Overall target intent"),
  );
  assert.ok(
    dialog
      .getByRole("region", { name: "To overall notes at V1" })
      .textContent?.includes("Overall baseline intent"),
  );
  const blank = structuredClone(state);
  blank.revisions[0].manifest.notes = {
    problem: " ",
    modification: "",
    observations: "",
  };
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: blank })} />);
  assert.ok(
    dialog
      .getByRole("region", { name: "To overall notes at V1" })
      .textContent?.includes("No overall engineering notes at this endpoint."),
  );
});
