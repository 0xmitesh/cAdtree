import "../../tests/dom";
import { pickFile } from "../../tests/file-picker";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { HistoryRecoveryView, type HistoryRecoveryViewProps } from "./HistoryRecoveryView";
import { ApplicationStatus } from "./ApplicationStatus";
import { historyState } from "../../tests/history-data";
import type { GetVersionCheck, GetVersionController } from "../app/useGetVersionActions";
import { scannedWorkingFile, useGetVersionActions } from "../app/useGetVersionActions";
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { createManagedBranch, createProject, createWorkspace, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import { captureRevision } from "../engine/revision-service";
import { openExistingVault } from "../engine/vault-service";
import { branchApplications } from "../engine/application-records";
import { scanBranchChanges } from "../engine/scanner";
import { getBranchBaseline } from "../engine/branch-state";
import { ReplacePlanChangedError } from "../engine/apply-preview";
import type { Context, Perform, StatusBanner } from "../app/types";
afterEach(cleanup);

const HOUSING = "Parts/Housing.SLDPRT";
const revBtn = (ui: ReturnType<typeof render>, n: string) =>
  ui.getByRole("button", { name: new RegExp(`^V${Number(n)}:`) });
const files = (ui: ReturnType<typeof render>) =>
  ui.container.querySelector(".detail-files") as HTMLElement;

function spy(overrides: Partial<GetVersionCheck> = {}, extra: Partial<GetVersionController> = {}) {
  const checks: [string, string][] = [];
  const confirmed: GetVersionCheck[] = [];
  const controller: GetVersionController = {
    check: async (revisionId, path) => {
      checks.push([revisionId, path]);
      return {
        projectId: "visual-project", branchId: "branch-main", revisionId, path,
        revisionLabel: `V${revisionId.slice(1)}`, fromLabel: `V${revisionId.slice(1)}`, planHash: "h", blockers: [],
        hasUnsavedEdits: false, keptFolder: "Discarded/2026-11-20 09.30", ...overrides,
      };
    },
    confirm: async (check) => {
      confirmed.push(check);
    },
    workingFile: () => undefined,
    ...extra,
  };
  return { controller, checks, confirmed };
}
const props = (getVersion?: GetVersionController): HistoryRecoveryViewProps => ({
  vaultState: historyState(3),
  activeBranchId: "branch-main",
  progress: null,
  statusBanner: null,
  onVerifySingleRevisionObjects: async () => {},
  onCancelOperation: () => {},
  getVersion,
});

test("version details: each saved file offers Get this version; none without the controller", () => {
  const ui = render(<HistoryRecoveryView {...props(spy().controller)} />);
  fireEvent.click(revBtn(ui, "001"));
  assert.equal(within(files(ui)).getAllByRole("button", { name: "Get this version" }).length, 5);
  cleanup();
  const without = render(<HistoryRecoveryView {...props()} />);
  fireEvent.click(revBtn(without, "001"));
  assert.equal(within(files(without)).queryAllByRole("button", { name: "Get this version" }).length, 0);
});

test("not offered on deleted rows or damaged versions", () => {
  const state = historyState(3);
  state.revisions[2].manifest.files = state.revisions[2].manifest.files.filter(
    (f) => f.path !== "Drawings/Actuator.SLDDRW",
  );
  const ui = render(<HistoryRecoveryView {...props(spy().controller)} vaultState={state} />);
  fireEvent.click(revBtn(ui, "003"));
  const deleted = [...files(ui).querySelectorAll(".detail-file")].find((row) =>
    row.textContent!.includes("Drawings/Actuator.SLDDRW"),
  ) as HTMLElement;
  assert.match(deleted.textContent!, /Deleted/);
  assert.equal(within(deleted).queryAllByRole("button", { name: "Get this version" }).length, 0);
  assert.ok(within(files(ui)).getAllByRole("button", { name: "Get this version" }).length > 0);
  cleanup();
  const damaged = historyState(3);
  damaged.revisions[1].integrityStatus = "corrupted";
  const d = render(<HistoryRecoveryView {...props(spy().controller)} vaultState={damaged} />);
  fireEvent.click(revBtn(d, "002"));
  assert.match(d.container.textContent!, /Damaged version/);
  assert.equal(within(files(d)).queryAllByRole("button", { name: "Get this version" }).length, 0);
});

test("the latest version's file is not offered when the working file still matches it", () => {
  const latest = historyState(3).revisions[2].manifest.files.find((f) => f.path === HOUSING)!;
  let working: { sha256: string; size: number } | null = { sha256: latest.sha256, size: latest.size };
  const ui = render(<HistoryRecoveryView {...props(spy({}, { workingFile: () => working }).controller)} />);
  fireEvent.click(revBtn(ui, "003"));
  assert.equal(within(files(ui)).queryAllByRole("button", { name: "Get this version" }).length, 0);
  cleanup();
  working = { sha256: "0".repeat(64), size: 1 };
  const edited = render(<HistoryRecoveryView {...props(spy({}, { workingFile: () => working }).controller)} />);
  fireEvent.click(revBtn(edited, "003"));
  assert.equal(within(files(edited)).getAllByRole("button", { name: "Get this version" }).length, 1);
});

test("File history: the picked file's row offers Get this version for an older version", async () => {
  const { controller, checks } = spy();
  const ui = render(<HistoryRecoveryView {...props(controller)} />);
  pickFile(ui, HOUSING);
  fireEvent.click(revBtn(ui, "002"));
  fireEvent.click(within(files(ui)).getByRole("button", { name: "Get this version" }));
  await waitFor(() => assert.deepEqual(checks, [["r2", HOUSING]]));
});

test("confirm dialog: the question, no warning without unsaved edits, and Confirm sends the checked plan", async () => {
  const { controller, confirmed } = spy();
  const ui = render(<HistoryRecoveryView {...props(controller)} />);
  fireEvent.click(revBtn(ui, "002"));
  fireEvent.click(within(files(ui)).getByRole("button", { name: "Get this version" }));
  const dialog = await waitFor(() => ui.getByRole("dialog", { name: "Get this version" }));
  await waitFor(() =>
    assert.match(
      dialog.textContent!,
      /Put Parts\/Housing\.SLDPRT from V2 into your working folder\? It will show as an unsaved change\./,
    ),
  );
  assert.doesNotMatch(dialog.textContent!, /current edits/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Get this version" }));
  await waitFor(() => assert.equal(confirmed.length, 1));
  assert.equal(confirmed[0].path, HOUSING);
  await waitFor(() => assert.equal(ui.queryByRole("dialog"), null));
});

test("confirm dialog: warns that unsaved edits are kept; blockers and a blocked case disable it", async () => {
  const edits = render(<HistoryRecoveryView {...props(spy({ hasUnsavedEdits: true }).controller)} />);
  fireEvent.click(revBtn(edits, "002"));
  fireEvent.click(within(files(edits)).getByRole("button", { name: "Get this version" }));
  const dialog = await waitFor(() => edits.getByRole("dialog", { name: "Get this version" }));
  await waitFor(() =>
    assert.match(dialog.textContent!, /Your current edits will be kept in Discarded\/2026-11-20 09\.30\./),
  );
  cleanup();
  const blocked = render(
    <HistoryRecoveryView {...props(spy({ blockers: ["This file was renamed since that version."] }).controller)} />,
  );
  fireEvent.click(revBtn(blocked, "002"));
  fireEvent.click(within(files(blocked)).getByRole("button", { name: "Get this version" }));
  const d2 = await waitFor(() => blocked.getByRole("dialog", { name: "Get this version" }));
  await waitFor(() => assert.match(d2.textContent!, /renamed since/));
  assert.equal((within(d2).getByRole("button", { name: "Get this version" }) as HTMLButtonElement).disabled, true);
  cleanup();
  const readOnly = render(<HistoryRecoveryView {...props(spy({}, { blockedReason: "This case is hidden." }).controller)} />);
  fireEvent.click(revBtn(readOnly, "002"));
  assert.equal(
    (within(files(readOnly)).getByRole("button", { name: "Get this version" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("confirm dialog: a stale plan checks again and asks to review; other errors are shown as they are", async () => {
  let attempt = 0;
  const { controller, checks, confirmed } = spy({}, {});
  const confirm = controller.confirm;
  controller.confirm = async (check) => {
    attempt++;
    if (attempt === 1) throw new ReplacePlanChangedError();
    if (attempt === 2) throw new Error("Changes differ from what you saw; review again. Not a typed error.");
    await confirm(check);
  };
  const ui = render(<HistoryRecoveryView {...props(controller)} />);
  fireEvent.click(revBtn(ui, "002"));
  fireEvent.click(within(files(ui)).getByRole("button", { name: "Get this version" }));
  const dialog = await waitFor(() => ui.getByRole("dialog", { name: "Get this version" }));
  const button = () => within(dialog).getByRole("button", { name: "Get this version" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(button().disabled, false));
  fireEvent.click(button());
  await waitFor(() => assert.ok(within(dialog).getByText("Changes differ from what you saw; review again.")));
  await waitFor(() => assert.equal(checks.length, 2, "checked again"));
  await waitFor(() => assert.equal(button().disabled, false));
  fireEvent.click(button());
  await waitFor(() =>
    assert.ok(within(dialog).getByText("Changes differ from what you saw; review again. Not a typed error.")),
  );
  assert.equal(checks.length, 2, "text alone does not check again");
  assert.equal(within(dialog).queryByText("Changes differ from what you saw; review again."), null);
  fireEvent.click(button());
  await waitFor(() => assert.equal(confirmed.length, 1));
  await waitFor(() => assert.equal(ui.queryByRole("dialog"), null));
});

test("scannedWorkingFile reads the active case's scan only", () => {
  const file = { path: "A.txt", sha256: "a".repeat(64), size: 1, lastModified: 0 };
  const scan = {
    branchId: "branch-main", added: [], modified: [], deleted: [], unchanged: [file],
  } as unknown as Parameters<typeof scannedWorkingFile>[0];
  assert.deepEqual(scannedWorkingFile(scan, "branch-main", "A.txt"), { sha256: file.sha256, size: 1 });
  assert.equal(scannedWorkingFile(scan, "other", "A.txt"), undefined);
  assert.equal(scannedWorkingFile(null, "branch-main", "A.txt"), undefined);
  assert.equal(scannedWorkingFile(scan, "branch-main", "B.txt"), null);
});

// ---- The hook with a real in-memory project ----
test("the hook checks with a fresh scan, writes through perform, rescans and says how to keep or undo it", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const created = await createProject(root, "Gripper");
  const vault = created.vaultDir;
  const folders = { ...created.workingFolders } as Record<string, FileSystemDirectoryAdapter>;
  const main = folders["branch-main"]!;
  const notes = { problem: "", modification: "", observations: "" };
  const save = () => captureRevision(main, vault, { branchId: "branch-main", summary: "S", notes, workingFolders: folders });
  await main.writeFileText(["A.txt"], "a1");
  const r1 = (await save()).revision.manifest.revisionId;
  await main.writeFileText(["A.txt"], "a2");
  await save();
  await main.writeFileText(["A.txt"], "a3 unsaved");
  const banners: (StatusBanner | null)[] = [];
  const kinds: string[] = [];
  let writableChecks = 0;
  let refreshes = 0;
  const perform = (async (kind: string, action: (c: Context) => Promise<unknown>) => {
    kinds.push(kind);
    return action({ version: 0, signal: new AbortController().signal, current: () => true, progress: () => {} });
  }) as unknown as Perform;
  const managed = { record: created.record } as unknown as ManagedProject;
  const { result } = renderHook(() =>
    useGetVersionActions({
      vaultDir: vault,
      workingDir: main,
      workingFolders: folders,
      activeBranchId: "branch-main",
      managedProject: managed,
      workspace: { root } as unknown as WorkspaceState,
      perform,
      assertProjectWritable: async () => {
        writableChecks++;
        return managed;
      },
      applicationOptions: (context) => ({ workingFolders: folders, signal: context.signal }),
      applyVaultState: () => {},
      requestAutoRefresh: () => {
        refreshes++;
      },
      setStatusBanner: (next) => {
        banners.push(typeof next === "function" ? next(banners.at(-1) ?? null) : next);
      },
    }),
  );
  const check = await result.current.check(r1, "A.txt");
  assert.deepEqual(check.blockers, []);
  assert.equal(check.revisionLabel, "V1");
  assert.equal(check.hasUnsavedEdits, true);
  assert.equal(writableChecks, 0, "the check only reads");
  await result.current.confirm(check);
  assert.equal(writableChecks, 1);
  assert.deepEqual(kinds, ["apply", "apply"]);
  assert.equal(await main.readFileText(["A.txt"]), "a1");
  assert.equal(refreshes, 1);
  assert.match(
    banners.at(-1)!.message,
    /^V1 of A\.txt is in your working folder\. Save to keep it, or Discard to undo\. The file it replaced is kept in Discarded\//,
  );
  const state = await openExistingVault(vault);
  assert.equal(branchApplications(state, "branch-main")[0].status, "done");
  const scan = await scanBranchChanges(main, "branch-main", getBranchBaseline(state, "branch-main"));
  assert.deepEqual(scan.modified.map((m) => m.current.path), ["A.txt"]);
  // A stale check (the file changed after it) is refused and changes nothing.
  const again = await result.current.check(r1, "A.txt");
  assert.match(again.blockers.join(" "), /already matches/);
  const fresh = await result.current.check((await openExistingVault(vault)).revisions[1].manifest.revisionId, "A.txt");
  await main.writeFileText(["A.txt"], "edited after the check");
  await assert.rejects(result.current.confirm(fresh), ReplacePlanChangedError);
  assert.equal(await main.readFileText(["A.txt"]), "edited after the check");
  // A revision of another case says which case it is on.
  const withCase = await createManagedBranch(root, created.record.containerPath, {
    sourceRevisionId: r1, name: "Lighter", reason: "Try",
  });
  const caseDir = withCase.workingFolders[withCase.createdBranchId]!;
  await caseDir.writeFileText(["A.txt"], "case version");
  const caseRev = (
    await captureRevision(caseDir, vault, {
      branchId: withCase.createdBranchId, summary: "C", notes,
      workingFolders: { ...folders, ...withCase.workingFolders },
    })
  ).revision.manifest;
  const other = await result.current.check(caseRev.revisionId, "A.txt");
  assert.equal(other.fromLabel, `V${caseRev.displayNumber} on Lighter`);
  assert.equal(check.fromLabel, "V1");
});

test("an interrupted Get this version is labelled Undo the unfinished Get this version", () => {
  const state = historyState(3);
  state.applicationOperations = [
    {
      operationId: "20261120-093000",
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/20261120-093000",
      status: "unresolved",
      events: [],
      record: {
        plan: { mode: "restore-file", sourceRevisionId: "r1", destinationRevisionId: "r3", baseRevisionId: "r3", destinationBranchId: "branch-main", actions: [], folderActions: [], reason: "" },
      },
    } as unknown as NonNullable<typeof state.applicationOperations>[number],
  ];
  const ui = render(
    <ApplicationStatus state={state} branchId="branch-main" busy={false} progress={null} onCancel={() => {}} onRecover={async () => {}} onSaveNow={() => {}} onDontSave={async () => {}} />,
  );
  assert.match(ui.getByRole("region").textContent!, /A Get this version was interrupted/);
  assert.ok(ui.getByRole("button", { name: "Undo the unfinished Get this version" }));
});
