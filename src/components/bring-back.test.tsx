import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { ApplyPreviewDialog, type ApplicationController } from "./ApplyPreviewDialog";
import { AppliedFrom, AppliedFromDetails, ApplicationStatus } from "./ApplicationStatus";
import { HistoryRecoveryView, type HistoryRecoveryViewProps } from "./HistoryRecoveryView";
import { scenarioState } from "../../tests/history-data";
import { applyModeFor, buildApplyPreview, prepareApplyPreview } from "../engine/apply-preview";
import { applicationReview } from "../engine/application-service";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import { branchApplications, sealApplication, type ApplicationOperation, type ApplicationReview } from "../engine/application-records";
import { initializeProjectVault, openExistingVault } from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { scanBranchChanges } from "../engine/scanner";
import { getBranchBaseline } from "../engine/branch-state";
import { useApplicationActions } from "../app/useApplicationActions";
import type { Context, Perform, StatusBanner } from "../app/types";
import type { VaultState } from "../engine/types";
afterEach(cleanup);

// Main r1..r6, prototype forks from r2 (p1, p2). r6 (Main's latest) gets an
// extra file and r3 an older-only file so bringing r3 back has all three kinds.
function fixture() {
  const state = scenarioState("branches");
  const file = (p: string) => ({ path: p, sha256: "9".repeat(8), size: 3, lastModified: 0 });
  state.revisions[5].manifest.files.push(file("Extra.txt"));
  state.revisions[2].manifest.files.push(file("Old.txt"));
  return state;
}
const props = (
  state = fixture(),
  activeBranchId = "branch-main",
): HistoryRecoveryViewProps => ({
  vaultState: state,
  activeBranchId,
  progress: null,
  statusBanner: null,
  onVerifySingleRevisionObjects: async () => {},
  onCancelOperation: () => {},
});
const revBtn = (ui: ReturnType<typeof render>, n: string) =>
  ui.getByRole("button", { name: new RegExp(`^V${Number(n)}:`) });
function controllerSpy(extra: Partial<ApplicationController> = {}) {
  const sent: ApplicationReview[] = [];
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    applyAndSave: async (review) => {
      sent.push(review);
      return undefined;
    },
    ...extra,
  };
  return { sent, controller };
}

test("applyModeFor: latest, revert, merge, and no baseline falls back to merge", () => {
  const state = fixture();
  assert.equal(applyModeFor(state, "r6", "branch-main"), "latest");
  assert.equal(applyModeFor(state, "r3", "branch-main"), "revert");
  assert.equal(applyModeFor(state, "p2", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "p2", "prototype"), "latest");
  assert.equal(applyModeFor(state, "r2", "prototype"), "revert");
  assert.equal(applyModeFor(state, "r5", "prototype"), "merge");
  const empty = fixture();
  empty.branchHeads["branch-main"] = null;
  assert.equal(applyModeFor(empty, "r3", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "r3", "no-such-branch"), "merge");
});

test("History detail: latest has no button, an older Main version offers Bring back, a case version offers Copy files from <case>", () => {
  const ui = render(<HistoryRecoveryView {...props()} />);
  fireEvent.click(revBtn(ui, "006"));
  assert.equal(ui.queryByRole("button", { name: /Bring back onto|Copy files from/ }), null);
  fireEvent.click(revBtn(ui, "003"));
  assert.ok(ui.getByRole("button", { name: "Bring back onto Main…" }));
  assert.equal(ui.queryByRole("button", { name: /Copy files from/ }), null);
  fireEvent.click(revBtn(ui, "008"));
  assert.ok(ui.getByRole("button", { name: "Copy files from Prototype…" }));
  assert.equal(ui.queryByRole("button", { name: /Bring back onto/ }), null);
  assert.equal(ui.queryByRole("button", { name: "Review changes to apply" }), null);
});

test("with a case active, an earlier Main version before the fork says Bring back onto <case>", () => {
  const ui = render(<HistoryRecoveryView {...props(fixture(), "prototype")} />);
  fireEvent.click(revBtn(ui, "001"));
  assert.ok(ui.getByRole("button", { name: "Bring back onto Prototype…" }));
});

test("Bring back: one dialog with a read-only list grouped by change, an optional Why and one button that sends every change", async () => {
  const { sent, controller } = controllerSpy();
  let closed = 0;
  const ui = render(
    <ApplyPreviewDialog state={fixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => closed++} />,
  );
  const dialog = ui.getByRole("dialog", { name: "Bring back V3 onto Main" });
  const w = within(dialog);
  assert.equal(w.queryAllByRole("checkbox").length, 0, "the list is read-only");
  assert.match(w.getByRole("status", { name: "What will change" }).textContent!, /^3 files will change$/);
  assert.match(w.getByRole("region", { name: "Brought back" }).textContent!, /Old\.txt/);
  assert.match(w.getByRole("region", { name: "Replaced with the older version" }).textContent!, /Parts\/Housing\.SLDPRT/);
  assert.match(w.getByRole("region", { name: "Removed (not in V3)" }).textContent!, /Extra\.txt/);
  // No Base column, no Prepare, no confirm checkbox, no reason requirement.
  assert.doesNotMatch(dialog.textContent!, /Base|Prepare|Engineering reason/);
  const button = w.getByRole("button", { name: "Bring back" }) as HTMLButtonElement;
  assert.equal(button.disabled, false, "the reason is optional");
  fireEvent.change(w.getByRole("textbox", { name: "Why (optional)" }), { target: { value: " Housing change was wrong " } });
  fireEvent.click(button);
  await waitFor(() => assert.equal(closed, 1));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, "revert");
  assert.equal(sent[0].reason, "Housing change was wrong");
  assert.deepEqual(
    Object.entries(sent[0].choices).filter(([, c]) => c.selected).map(([p]) => p).sort(),
    ["Extra.txt", "Old.txt", "Parts/Housing.SLDPRT"],
  );
});

test("Bring back with unsaved changes shows Save my changes first instead of the button", () => {
  let saveFirst = 0, closed = 0;
  const { sent, controller } = controllerSpy({ unsavedChanges: 2, onSaveFirst: () => saveFirst++ });
  const ui = render(
    <ApplyPreviewDialog state={fixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => closed++} />,
  );
  assert.match(ui.getByRole("dialog").textContent!, /Main has 2 unsaved changes\. Save them first/);
  assert.equal(ui.queryByRole("button", { name: "Bring back" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Save my changes first" }));
  assert.equal(saveFirst, 1);
  assert.equal(closed, 1);
  assert.equal(sent.length, 0);
});

test("a failure shows in the dialog, which stays open; a busy or blocked case disables the button", async () => {
  const { controller } = controllerSpy({
    applyAndSave: async () => {
      throw new Error("Destination has uncaptured file or directory changes.");
    },
  });
  let closed = 0;
  const ui = render(
    <ApplyPreviewDialog state={fixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => closed++} />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Bring back" }));
  await waitFor(() => assert.match(ui.getByRole("alert").textContent!, /uncaptured/));
  assert.equal(closed, 0);
  cleanup();
  const blocked = controllerSpy({ blockedReason: "Finish the earlier Bring back or Copy on this case first." });
  const ui2 = render(
    <ApplyPreviewDialog state={fixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={blocked.controller} onClose={() => {}} />,
  );
  assert.equal((ui2.getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled, true);
  assert.match(ui2.getByRole("alert").textContent!, /Finish the earlier/);
});

const renamedBlock = (state: ReturnType<typeof fixture>) => {
  const cf = (path: string) => ({ path, componentId: "component-1" }) as any;
  state.components = {
    status: "available",
    revisions: {
      r3: { files: [cf("Old.txt")], payloadSha256: "x", renames: [] },
      r6: { files: [cf("Parts/Renamed.SLDPRT")], payloadSha256: "x", renames: [] },
    },
  } as any;
  return state;
};

test("a renamed file keeps today's blocked message, is listed apart and is left out of the Bring back", async () => {
  const { sent, controller } = controllerSpy();
  const ui = render(
    <ApplyPreviewDialog state={renamedBlock(fixture())} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />,
  );
  assert.match(
    ui.getByRole("listitem", { name: "Blocked: Old.txt" }).textContent!,
    /renamed since that version\. Bringing back cannot undo renames yet/,
  );
  assert.equal(ui.queryByRole("region", { name: "Brought back" }), null);
  assert.match(ui.getByRole("status", { name: "What will change" }).textContent!, /^2 files will change$/);
  fireEvent.click(ui.getByRole("button", { name: "Bring back" }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal("Old.txt" in sent[0].choices, false);
});

test("the Undo request opens Bring back for that version in History", () => {
  const { controller } = controllerSpy();
  const ui = render(<HistoryRecoveryView {...props()} application={controller} bringBackRequest={{ revisionId: "r3", nonce: 1 }} />);
  assert.equal(ui.queryByRole("dialog"), null, "a request older than the view is not replayed");
  ui.rerender(<HistoryRecoveryView {...props()} application={controller} bringBackRequest={{ revisionId: "r3", nonce: 2 }} />);
  assert.ok(ui.getByRole("dialog", { name: "Bring back V3 onto Main" }));
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  assert.equal(ui.queryByRole("dialog"), null);
  ui.rerender(<HistoryRecoveryView {...props()} application={controller} bringBackRequest={{ revisionId: "r3", nonce: 2 }} />);
  assert.equal(ui.queryByRole("dialog"), null, "the same request does not open it again");
  ui.rerender(<HistoryRecoveryView {...props()} application={controller} bringBackRequest={{ revisionId: "r3", nonce: 3 }} />);
  assert.ok(ui.getByRole("dialog", { name: "Bring back V3 onto Main" }));
});

function capturedOperation(mode: "merge" | "revert", reason = "Because") {
  const state = fixture();
  const source = mode === "revert" ? "r3" : "p2";
  const prep = prepareApplyPreview(state, source, "branch-main", mode);
  if (prep.status !== "available") throw new Error(prep.reason);
  const choices = { "Old.txt": { selected: true, decision: "use-source" as const } };
  const plan = buildApplyPreview(prep.context, choices, reason);
  const op: ApplicationOperation = {
    operationId: "apply-test",
    destinationBranchId: "branch-main",
    relativePath: "applications/branch-main/apply-test",
    status: "captured",
    capturedRevisionId: "final",
    events: [
      {
        schemaVersion: 1,
        operationId: "apply-test",
        sequence: 1,
        previous: "",
        kind: "capture",
        at: "now",
        revisionId: "final",
        manifestSha256: "h",
        checksum: "h",
        finalFiles: plan.actions.map((a) => ({
          path: a.path,
          file: a.after ? { ...a.after } : null,
        })),
      },
    ] as any,
    record: sealApplication({
      schemaVersion: 1 as const,
      kind: "cadtree-file-application" as const,
      operationId: "apply-test",
      createdAt: "2026-11-01",
      sourceBranchId: prep.context.source.manifest.branchId,
      review: applicationReview(plan, choices),
      plan,
    }),
  };
  state.applicationOperations = [op];
  return state;
}

test("AppliedFrom is one plain line: Brought back <rev> / Copied from <rev> on <case>, with no dangling dash when there is no reason", () => {
  const revert = render(<AppliedFrom state={capturedOperation("revert")} revisionId="final" />);
  assert.equal(revert.container.textContent, "Brought back V3 — Because");
  assert.equal(revert.container.querySelectorAll("details").length, 0);
  cleanup();
  const merge = render(<AppliedFrom state={capturedOperation("merge")} revisionId="final" />);
  assert.equal(merge.container.textContent, "Copied from V8 on Prototype — Because");
  cleanup();
  const noReason = render(<AppliedFrom state={capturedOperation("revert", "")} revisionId="final" />);
  assert.equal(noReason.container.textContent, "Brought back V3");
  cleanup();
  const long = capturedOperation("merge");
  const longReason = "Reuse the reviewed housing change but keep every newer Main development";
  long.applicationOperations![0].record!.plan.reason = longReason;
  const longUi = render(<AppliedFrom state={long} revisionId="final" />);
  assert.equal(longUi.container.querySelector(".applied-from-reason")!.textContent, longReason);
  cleanup();
  const revertDetails = render(<AppliedFromDetails state={capturedOperation("revert")} revisionId="final" />);
  assert.doesNotMatch(revertDetails.container.textContent!, /Base:/);
  assert.match(revertDetails.container.textContent!, /Destination baseline:/);
});

// ---- The hook with a real in-memory project ----
async function project() {
  const vault = new InMemoryFileSystemAdapter("UVault"),
    main = new InMemoryFileSystemAdapter("UMain");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  await main.writeFileText(["A.txt"], "a1");
  await initializeProjectVault(main, vault, "Bring back UI");
  const notes = { problem: "", modification: "", observations: "" };
  const save = (summary: string, extra = {}) =>
    captureRevision(main, vault, { branchId: "branch-main", summary, notes, workingFolders: folders, ...extra });
  const r1 = (await save("R1")).revision.manifest;
  await main.writeFileText(["A.txt"], "a2");
  const r2 = (await save("R2")).revision.manifest;
  return { vault, main, folders, save, r1, r2 };
}
function hook(f: Awaited<ReturnType<typeof project>>, initial: VaultState) {
  const banners: (StatusBanner | null)[] = [];
  let state = initial;
  let refreshes = 0;
  const perform = (async (_kind: string, action: (c: Context) => Promise<unknown>) =>
    action({ version: 0, signal: new AbortController().signal, current: () => true, progress: () => {} })) as unknown as Perform;
  const rendered = renderHook(() =>
    useApplicationActions({
      vaultDir: f.vault,
      vaultState: state,
      workingDir: f.main,
      workingFolders: f.folders,
      activeBranchId: "branch-main",
      managedProject: null,
      workspace: null,
      perform,
      assertProjectWritable: async () => null,
      applyVaultState: (next) => {
        state = next;
      },
      requestAutoRefresh: () => {
        refreshes++;
      },
      setStatusBanner: (next) => {
        banners.push(typeof next === "function" ? next(banners.at(-1) ?? null) : next);
      },
    }),
  );
  const setState = (next: VaultState) => {
    state = next;
    rendered.rerender();
  };
  return { rendered, banners, state: () => state, setState, refreshes: () => refreshes };
}
const revertReview = (state: VaultState, sourceId: string, reason = "") => {
  const prep = prepareApplyPreview(state, sourceId, "branch-main", "revert");
  if (prep.status !== "available") throw new Error(prep.reason);
  const choices = Object.fromEntries(
    prep.context.rows.filter((r) => r.kind === "available").map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
  );
  return applicationReview(buildApplyPreview(prep.context, choices, reason), choices);
};

test("success: saved automatically, reloads and rescans, and says Saved as V3. To undo, bring back V2 (Undo opens Bring back)", async () => {
  const f = await project();
  const h = hook(f, await openExistingVault(f.vault));
  let result: any;
  await act(async () => {
    result = await h.rendered.result.current.handleApplyAndSave(revertReview(h.state(), f.r1.revisionId));
  });
  assert.equal(result.status, "saved");
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(h.state().revisions.length, 3, "the vault was reloaded");
  assert.equal(h.refreshes(), 1, "an automatic rescan was asked for");
  const banner = h.banners.at(-1)!;
  assert.equal(banner.message, "Saved as V3. To undo, bring back V2.");
  assert.equal(banner.action?.label, "Undo");
  act(() => banner.action!.run());
  assert.equal(h.rendered.result.current.bringBackRequest?.revisionId, f.r2.revisionId);
});

test("not saved: the files stay, the status says why with Save now, and the prefilled normal save links the provenance once", async () => {
  const f = await project();
  const h = hook(f, await openExistingVault(f.vault));
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/revisions/")) throw new Error("manifest write failed");
    },
  });
  let result: any;
  await act(async () => {
    result = await h.rendered.result.current.handleApplyAndSave(revertReview(h.state(), f.r1.revisionId, "Wrong turn"));
  });
  f.vault.setHooks({ onBeforeWrite: undefined });
  assert.equal(result.status, "not-saved");
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(h.banners.filter(Boolean).length, 0, "no success banner");
  const state = h.state();
  const op = branchApplications(state, "branch-main").at(-1)!;
  assert.equal(op.status, "applied");
  let saveNow: ApplicationOperation | null = null;
  const ui = render(
    <ApplicationStatus
      state={state}
      branchId="branch-main"
      busy={false}
      progress={null}
      notSavedReasons={h.rendered.result.current.notSavedReasons}
      onCancel={() => {}}
      onRecover={async () => {}}
      onSaveNow={(o) => {
        saveNow = o;
      }}
      onDontSave={async () => {}}
    />,
  );
  assert.match(
    ui.getByRole("region").textContent!,
    /Brought back V1, but it wasn't saved: .*manifest write failed.*\. Your working files are fine\./,
  );
  assert.equal(ui.queryByRole("button", { name: /Abandon|Refresh/ }), null);
  fireEvent.click(ui.getByRole("button", { name: "Save now" }));
  assert.equal(saveNow!.operationId, op.operationId);
  act(() => h.rendered.result.current.handleSaveNow(saveNow!));
  const prefill = h.rendered.result.current.capturePrefill!;
  assert.equal(prefill.summary, "Brought back V1");
  assert.equal(prefill.notes.problem, "Wrong turn");
  assert.equal(prefill.branchId, "branch-main");
  const scan = await scanBranchChanges(f.main, "branch-main", getBranchBaseline(state, "branch-main"));
  const saved = await f.save(prefill.summary, { notes: prefill.notes, reviewedChangesSignature: scan.changesSignature });
  const after = await openExistingVault(f.vault);
  const linked = branchApplications(after, "branch-main").at(-1)!;
  assert.equal(linked.status, "captured");
  assert.equal(linked.capturedRevisionId, saved.revision.manifest.revisionId);
  assert.equal(linked.events.filter((e) => e.kind === "capture").length, 1);
  // Once saved, the prefill is gone: going back to Changes fills nothing in.
  act(() => h.setState(after));
  assert.equal(h.rendered.result.current.capturePrefill, null);
  act(() => h.setState(state));
  assert.equal(h.rendered.result.current.capturePrefill, null, "dropped for good, not just hidden");
});

test("Don't save it: the files stay, the case is no longer blocked and a later Bring back saves", async () => {
  const f = await project();
  const h = hook(f, await openExistingVault(f.vault));
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/revisions/")) throw new Error("manifest write failed");
    },
  });
  await act(async () => {
    await h.rendered.result.current.handleApplyAndSave(revertReview(h.state(), f.r1.revisionId));
  });
  f.vault.setHooks({ onBeforeWrite: undefined });
  const op = branchApplications(h.state(), "branch-main").at(-1)!;
  assert.equal(op.status, "applied");
  act(() => h.rendered.result.current.handleSaveNow(op));
  assert.ok(h.rendered.result.current.capturePrefill);
  // The user put the file back by hand: nothing to save, the case would stay blocked.
  await f.main.writeFileText(["A.txt"], "a2");
  await assert.rejects(
    h.rendered.result.current.handleApplyAndSave(revertReview(h.state(), f.r1.revisionId)),
    /unfinished Bring back.*Don't save it/,
  );
  // The status offers Don't save it inside Details, with a confirm.
  let dontSave = "";
  const ui = render(
    <ApplicationStatus state={h.state()} branchId="branch-main" busy={false} progress={null} onCancel={() => {}}
      onRecover={async () => {}} onSaveNow={() => {}} onDontSave={async (id) => { dontSave = id; }} />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Don't save it" }));
  const confirm = ui.getByRole("dialog", { name: "Don't save this Bring back" });
  assert.match(confirm.textContent!, /Your working files stay as they are; cAdtree just stops waiting to save this Bring back\./);
  fireEvent.click(within(confirm).getByRole("button", { name: "Don't save it" }));
  await waitFor(() => assert.equal(dontSave, op.operationId));
  await act(async () => {
    await h.rendered.result.current.handleDontSave(op.operationId);
  });
  assert.equal(await f.main.readFileText(["A.txt"]), "a2", "working files untouched");
  assert.equal(branchApplications(h.state(), "branch-main").at(-1)!.status, "abandoned");
  assert.equal(h.rendered.result.current.capturePrefill, null);
  let result: any;
  await act(async () => {
    result = await h.rendered.result.current.handleApplyAndSave(revertReview(h.state(), f.r1.revisionId));
  });
  assert.equal(result.status, "saved");
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
});

test("an interrupted write is labelled Undo the unfinished Bring back and needs the CAD-close acknowledgement", async () => {
  const state = capturedOperation("revert");
  const op = state.applicationOperations![0];
  op.status = "unresolved";
  let recovers = 0;
  const ui = render(
    <ApplicationStatus state={state} branchId="branch-main" busy={false} progress={null} onCancel={() => {}} onRecover={async () => { recovers++; }} onSaveNow={() => {}} onDontSave={async () => {}} />,
  );
  assert.match(ui.getByRole("region").textContent!, /A Bring back was interrupted/);
  assert.equal(ui.queryByRole("button", { name: "Save now" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Undo the unfinished Bring back" }));
  const dialog = ui.getByRole("dialog", { name: "Undo the unfinished Bring back" });
  const confirm = within(dialog).getByRole("button", { name: "Undo the unfinished Bring back" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have saved and closed these files in my CAD program." }));
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(recovers, 1));
});

test("Save now fills the normal save once per request: summary, and Why with the description shown", async () => {
  const { ChangesCaptureView } = await import("./ChangesCaptureView");
  const state = scenarioState("single");
  const head = state.branchHeads["branch-main"]!;
  const scan = {
    scannedAt: "2026-11-19T00:00:00.000Z",
    branchId: "branch-main",
    baselineRevisionId: head,
    baselineDisplayNumber: 1,
    added: [{ path: "A.txt", sha256: "a", size: 1, lastModified: 0 }],
    modified: [],
    deleted: [],
    unchanged: [],
    directories: [],
    addedDirectories: [],
    deletedDirectories: [],
    errors: [],
    hasChanges: true,
    canCapture: true,
    totalBytes: 1,
    changesSignature: "sig",
  };
  const view = (prefill?: { summary: string; notes: any; key: string }) => (
    <ChangesCaptureView
      vaultState={state}
      activeBranchId="branch-main"
      workingFolderName="main"
      vaultFolderName="Vault"
      scanResult={scan}
      isScanStale={false}
      isScanning={false}
      isCapturing={false}
      progress={null}
      statusBanner={null}
      onScan={async () => {}}
      onCapture={async () => {}}
      onCancelOperation={() => {}}
      onReattachWorkingFolder={async () => {}}
      prefill={prefill}
    />
  );
  const notes = { problem: "Wrong turn", modification: "", observations: "" };
  const ui = render(view());
  const summary = () => ui.getByRole("textbox", { name: /Version summary/ }) as HTMLInputElement;
  assert.equal(summary().value, "");
  ui.rerender(view({ summary: "Brought back V1", notes, key: "op:1" }));
  assert.equal(summary().value, "Brought back V1");
  assert.equal((ui.getByRole("textbox", { name: "Overall: Why" }) as HTMLTextAreaElement).value, "Wrong turn");
  fireEvent.change(summary(), { target: { value: "Edited" } });
  ui.rerender(view({ summary: "Brought back V1", notes, key: "op:1" }));
  assert.equal(summary().value, "Edited", "the same request does not overwrite the user's edits");
  ui.rerender(view({ summary: "Brought back V1", notes: { ...notes, problem: "Other" }, key: "op:2" }));
  assert.equal(summary().value, "Edited", "a new request fills only empty fields");
  assert.equal((ui.getByRole("textbox", { name: "Overall: Why" }) as HTMLTextAreaElement).value, "Wrong turn");
});
