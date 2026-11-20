import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { scenarioState } from "../../tests/history-data";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
import { formatTimestamp } from "../utils/format";
import { captureRevision, ReviewStaleError } from "../engine/revision-service";

afterEach(cleanup);
test("clicking a case chip selects that case's latest version and fades nothing, in graph and list", () => {
  const ui = render(
    <HistoryRecoveryView
      {...historyProps({ vaultState: scenarioState("branches") })}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: /V3:/ }));
  fireEvent.click(ui.getByRole("button", { name: "Prototype" }));
  assert.equal(
    ui.getByRole("button", { name: /^V8:/ }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(ui.container.querySelectorAll(".dimmed").length, 0);
  // Only revisions saved on the case carry the accent, not the Main history it branched from.
  const marked = () =>
    [...ui.container.querySelectorAll(".graph-row.in-case .graph-hit")].map(
      (hit) => /V(\d+)/.exec(hit.getAttribute("aria-label")!)![1],
    );
  assert.deepEqual(marked().sort(), ["7", "8"]);
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  fireEvent.click(ui.getByRole("button", { name: /^V3 / }));
  fireEvent.click(ui.getByRole("button", { name: "Main" }));
  assert.equal(
    ui.container
      .querySelector(".revision-list-row.selected")!
      .textContent!.includes("V6"),
    true,
  );
  assert.equal(ui.container.querySelectorAll(".dimmed").length, 0);
  const markedRows = [...ui.container.querySelectorAll(".revision-list-row.in-case")].map(
    (row) => /V(\d+)/.exec(row.textContent!)![1],
  );
  assert.deepEqual(markedRows.sort(), ["1", "2", "3", "4", "5", "6"]);
  // Clicking the same chip again clears the emphasis.
  fireEvent.click(ui.getByRole("button", { name: "Main" }));
  assert.equal(ui.container.querySelectorAll(".in-case").length, 0);
  assert.equal(
    ui.getByRole("button", { name: "Main" }).getAttribute("aria-pressed"),
    "false",
  );
});
test("a case with no versions of its own yet marks its starting version when its chip is clicked", () => {
  const state = scenarioState("branches");
  state.branches.push({
    ...state.branches[0],
    branchId: "fresh",
    name: "Fresh",
    isMain: false,
    startingRevisionId: "r3",
  });
  state.branchHeads.fresh = "r3";
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Fresh" }));
  const marked = [...ui.container.querySelectorAll(".graph-row.in-case .graph-hit")].map(
    (hit) => /V(\d+)/.exec(hit.getAttribute("aria-label")!)![1],
  );
  assert.deepEqual(marked, ["3"]);
  assert.equal(ui.getByRole("button", { name: /^V3:/ }).getAttribute("aria-pressed"), "true");
});
test("graph and list both list the newest version first; there are no zoom or Latest controls", () => {
  const ui = render(
    <HistoryRecoveryView {...historyProps({ vaultState: historyState(4) })} />,
  );
  const revisionNumbers = (selector: string) =>
    [...ui.container.querySelectorAll(selector)].map(
      (row) => /V(\d+)/.exec(row.getAttribute("aria-label") ?? row.textContent!)![1],
    );
  assert.deepEqual(revisionNumbers(".graph-hit"), ["4", "3", "2", "1"]);
  // Each edge runs from a child (higher row) down to its parent (lower row).
  const rowOf = new Map(
    [...ui.container.querySelectorAll(".graph-row")].map((row, index) => [
      /V(\d+)/.exec(row.querySelector(".graph-hit")!.getAttribute("aria-label")!)![1],
      index,
    ]),
  );
  const edges = [...ui.container.querySelectorAll(".graph-lines path[data-child]")];
  assert.equal(edges.length, 3);
  for (const edge of edges) {
    const child = "" + edge.getAttribute("data-child")!.slice(1);
    const parent = "" + edge.getAttribute("data-parent")!.slice(1);
    assert.ok(rowOf.get(child)! < rowOf.get(parent)!);
  }
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  assert.deepEqual(revisionNumbers(".revision-list-row"), ["4", "3", "2", "1"]);
  fireEvent.click(ui.getByRole("button", { name: "Graph" }));
  // Keyboard follows the visual order: Home is the newest, End the oldest.
  const newest = ui.getByRole("button", { name: /^V4:/ });
  fireEvent.keyDown(newest, { key: "End" });
  assert.equal(ui.getByRole("button", { name: /^V1:/ }).getAttribute("aria-pressed"), "true");
  fireEvent.keyDown(ui.getByRole("button", { name: /^V1:/ }), { key: "Home" });
  assert.equal(newest.getAttribute("aria-pressed"), "true");
  for (const name of [
    "Zoom in",
    "Zoom out",
    "Fit graph width and reset scroll",
    "Latest",
  ])
    assert.equal(ui.queryByRole("button", { name }), null);
  assert.equal(ui.container.querySelector(".zoom-controls"), null);
});
test("normal dates follow local day boundaries while Troubleshooting preserves exact UTC", () => {
  const previousTimezone = process.env.TZ;
  const state = historyState(1);
  const iso = "2026-10-29T20:15:37.123Z";
  state.revisions[0].manifest.captureCompletedAt = iso;
  try {
    // This UTC instant is the following day in India and still the previous day in New York.
    for (const timezone of ["Asia/Kolkata", "America/New_York"]) {
      process.env.TZ = timezone;
      const expected = new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(iso));
      assert.equal(formatTimestamp(iso), expected);
      const ui = render(
        <HistoryRecoveryView {...historyProps({ vaultState: state })} />,
      );
      const times = [...ui.container.querySelectorAll("time")];
      assert.equal(times.length, 2);
      assert.ok(
        times.every(
          (time) => time.textContent === expected && time.dateTime === iso,
        ),
      );
      fireEvent.click(ui.getByText("Troubleshooting"));
      assert.ok(ui.getByText("Capture completed (UTC)"));
      assert.ok(ui.getByText(iso));
      cleanup();
    }
    assert.equal(formatTimestamp("invalid date"), "invalid date");
    assert.equal(state.revisions[0].manifest.captureCompletedAt, iso);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
test("diagram labels and arrowheads follow parent identity, with children above ancestors", () => {
  const state = scenarioState("branches");
  const ui = render(
    <HistoryRecoveryView {...historyProps({ vaultState: state })} />,
  );
  assert.ok(ui.getByText("V1"));
  assert.ok(ui.getByText("V8"));
  const arrows = [
    ...ui.container.querySelectorAll<SVGPathElement>("path[data-parent]"),
  ];
  assert.equal(arrows.length, 7);
  for (const arrow of arrows) {
    const marker = arrow.getAttribute("marker-end")!;
    assert.match(marker, /^url\(#.*-parent-\d+\)$/);
    assert.ok(ui.container.querySelector('[id="' + marker.slice(5, -1) + '"]'));
    const coordinates = arrow
      .getAttribute("d")!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    assert.ok(
      coordinates[1] < coordinates.at(-1)!,
      "arrow points downward toward the recorded parent",
    );
  }
  const main = ui.getByRole("button", { name: "Main" });
  fireEvent.click(main);
  assert.equal(main.getAttribute("aria-pressed"), "true");
  assert.equal(
    ui
      .getByRole("button", { name: "Main head at V6" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(
    ui.getByRole("heading", { name: "Review assembly for manufacture" }),
  );
});
test("case highlighting changes only viewing state", () => {
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
});
const noop = async () => {};
function historyProps(
  overrides: Partial<HistoryRecoveryViewProps> = {},
): HistoryRecoveryViewProps {
  return {
    vaultState: historyState(2),
    activeBranchId: "branch-main",
    progress: null,
    statusBanner: null,
    onVerifySingleRevisionObjects: noop,
    onCancelOperation: () => {},
    ...overrides,
  };
}
test("graph selection, keyboard, and list mode share one immutable inspection state", () => {
  const props = historyProps();
  const before = JSON.stringify(props.vaultState);
  const ui = render(<HistoryRecoveryView {...props} />);
  const baseline = ui.getByRole("button", { name: /V1: Initial/ });
  fireEvent.click(baseline);
  assert.ok(ui.getByRole("heading", { name: "Initial baseline" }));
  // Newest is on top in both views, so ArrowUp moves to the next revision.
  fireEvent.keyDown(baseline, { key: "ArrowUp" });
  assert.equal(
    ui
      .getByRole("button", { name: /V2: Refine/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  assert.ok(ui.getByRole("heading", { name: "Refine housing clearance" }));
  fireEvent.click(ui.getByRole("button", { name: "Graph" }));
  assert.equal(
    ui
      .getByRole("button", { name: /V2: Refine/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(JSON.stringify(props.vaultState), before);
});
test("History offers no restore-copy buttons or per-file export boxes; the export dialog lists its own files", () => {
  const ui = render(
    <HistoryRecoveryView
      {...historyProps({
        onExportForReview: async () => {
          throw new Error("Export must not run");
        },
      })}
    />,
  );
  assert.equal(ui.queryByRole("button", { name: "Restore project copy" }), null);
  assert.equal(ui.queryByRole("button", { name: /Copy selected files/ }), null);
  assert.equal(ui.queryByText(/Recovery creates a separate copy/), null);
  assert.equal(ui.queryByRole("button", { name: "Select all snapshot files" }), null);
  assert.equal(ui.queryByRole("button", { name: "Clear" }), null);
  assert.equal(ui.container.querySelectorAll('input[type="checkbox"]').length, 0);
  fireEvent.click(ui.getByRole("button", { name: "Export a copy" }));
  const dialog = within(ui.getByRole("dialog"));
  assert.equal(
    (dialog.getByRole("radio", { name: /Complete project/ }) as HTMLInputElement).checked,
    true,
  );
  fireEvent.click(dialog.getByRole("radio", { name: /Selected files/ }));
  assert.equal(
    (dialog.getByRole("checkbox", { name: "Export Parts/Housing.SLDPRT" }) as HTMLInputElement).checked,
    false,
  );
});
test("unchanged files are available; deleted files link to their earlier snapshot", () => {
  const state = historyState(2);
  state.revisions[1].manifest.files = state.revisions[1].manifest.files.filter(
    (f) => f.path !== "Parts/Output_shaft.SLDPRT",
  );
  const ui = render(
    <HistoryRecoveryView {...historyProps({ vaultState: state })} />,
  );
  const listed = () =>
    [...ui.container.querySelectorAll(".detail-files .file-path")].map(
      (element) => element.textContent,
    );
  assert.ok(listed().includes("Parts/Output_shaft.SLDPRT"));
  assert.ok(!listed().includes("Actuator.SLDASM"));
  fireEvent.click(ui.getByRole("button", { name: /Show .* unchanged files/ }));
  assert.ok(listed().includes("Actuator.SLDASM"));
  fireEvent.click(ui.getByRole("button", { name: /View in parent version/ }));
  assert.ok(listed().includes("Parts/Output_shaft.SLDPRT"));
  assert.ok(ui.getByRole("heading", { name: "Initial baseline" }));
});
test("version details put the record information in a closed Troubleshooting disclosure instead of a tab", () => {
  const ui = render(<HistoryRecoveryView {...historyProps()} />);
  assert.equal(ui.queryByRole("button", { name: "Technical details" }), null);
  assert.deepEqual(
    [...ui.container.querySelectorAll(".detail-tabs button")].map((b) => b.textContent),
    ["Changed files", "Saved references", "Notes"],
  );
  const disclosure = ui
    .getByText("Troubleshooting")
    .closest("details") as HTMLDetailsElement;
  assert.ok(disclosure);
  assert.equal(disclosure.open, false);
  assert.ok(disclosure.contains(ui.getByRole("button", { name: "Verify file contents" })));
  assert.ok(disclosure.contains(ui.getByText(/File checksums \(\d+\)/)));
  // It sits below the panel's action bar, i.e. at the bottom of the revision details.
  const panel = ui.getByRole("complementary", { name: "Version details" });
  assert.equal(panel.lastElementChild, disclosure);
  assert.equal(ui.queryByText(/Current working file shortcuts/), null);
  assert.equal(ui.queryByRole("button", { name: /Copy folder path/ }), null);
});
test("damaged records stay visible and block export; healthy versions show no verification badge", () => {
  const props = historyProps({ onExportForReview: async () => { throw new Error("no"); } });
  props.vaultState.revisions[1].integrityStatus = "corrupted";
  const ui = render(<HistoryRecoveryView {...props} />);
  assert.ok(ui.getByText("Damaged version · export blocked"));
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Export a copy",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal((ui.getByText("Troubleshooting").closest("details") as HTMLDetailsElement).open, true);
  fireEvent.click(ui.getByRole("button", { name: /V1: Initial/ }));
  assert.equal(ui.queryByText(/Metadata verified/), null);
  assert.equal(ui.queryByText(/Damaged version/), null);
  assert.equal((ui.getByText("Troubleshooting").closest("details") as HTMLDetailsElement).open, false);
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
  fireEvent.change(ui.getByRole("textbox", { name: "New.SLDPRT: Why" }), {
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
        name: "New.SLDPRT: Why",
      }) as HTMLTextAreaElement
    ).value,
    "Improve retention",
  );
  fireEvent.submit(
    ui.getByRole("button", { name: "Save version" }).closest("form")!,
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
    ui.getByRole("button", { name: "Save version" }).closest("form")!,
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "confirm this file set" })),
  );
  assert.equal((await openExistingVault(vault)).revisions.length, 0);
  assert.equal(
    (ui.getByRole("button", { name: "Save version" }) as HTMLButtonElement)
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
    ui.getByRole("button", { name: "Save version" }).closest("form")!,
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
