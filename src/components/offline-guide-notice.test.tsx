import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { resolveManagedProject } from "../engine/workspace-service";
import { PROJECT_MAP_FILENAME } from "../engine/offline-guide-paths";
import type { GuideRefreshResult } from "../engine/offline-guide";
import { guideFailureReason, refreshGuidesAfter, useGuideProblem } from "../app/offline-guide-refresh";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { DiagnosticsView } from "./DiagnosticsView";

Object.assign(globalThis, { indexedDB });
afterEach(cleanup);

const noop = async () => {};
const NOTICE = /The offline guide couldn.t be updated/;

function Harness({ state, root, containerPath }: {
  state: Parameters<typeof DiagnosticsView>[0]["vaultState"];
  root: FileSystemDirectoryAdapter;
  containerPath: string;
}) {
  const guideProblem = useGuideProblem(root, containerPath, null);
  return (
    <DiagnosticsView
      vaultState={state}
      isVerifyingAll={false}
      onVerifyAllObjects={noop}
      onResetConnections={noop}
      workingFolderName="working/main"
      vaultFolderName="vault"
      onReattachWorkingFolder={noop}
      missingConnections={[]}
      guideProblem={guideProblem}
    />
  );
}

async function quietly<T>(work: () => Promise<T> | T): Promise<T> {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    return await work();
  } finally {
    console.warn = realWarn;
  }
}

test("a failed offline guide write shows a quiet notice in Settings; a later success clears it; nothing throws", async () => {
  const sample = await compareApplyRecoverSample();
  const containerPath = sample.project.record.containerPath;
  const state = (await resolveManagedProject(sample.workspace.root, containerPath)).vaultState;
  const ui = render(<Harness state={state} root={sample.workspace.root} containerPath={containerPath} />);
  assert.equal(ui.queryByText(NOTICE), null);

  sample.home.setHooks({ onBeforeWrite: (full) => { if (full.endsWith(PROJECT_MAP_FILENAME)) throw new Error("disk full"); } });
  const target = { workspaceRoot: sample.workspace.root, containerPath };
  assert.equal(await quietly(() => refreshGuidesAfter({ project: target })), undefined);
  await waitFor(() => assert.ok(ui.getByText(NOTICE)), { timeout: 10_000 });
  const text = ui.container.querySelector(".notice")!.textContent!;
  assert.match(text, /the project map couldn.t be written \(disk full\)/);
  assert.match(text, /It will try again after your next save\./);

  sample.home.setHooks({ onBeforeWrite: undefined });
  await quietly(() => refreshGuidesAfter({ project: target }));
  for (let i = 0; i < 100 && ui.queryByText(NOTICE); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  assert.equal(ui.queryByText(NOTICE), null);
});

test("a refresh that is skipped for a normal reason is not a failure", () => {
  const skipped: GuideRefreshResult = { status: "skipped", reason: "The project is read-only.", written: [], failed: [] };
  assert.equal(guideFailureReason(skipped), null);
  assert.equal(guideFailureReason({ status: "written", written: [], failed: [] }), null);
  assert.match(guideFailureReason({ ...skipped, error: "Not allowed." })!, /couldn.t be read \(Not allowed\)/);
  assert.match(
    guideFailureReason({ status: "partial", written: [], failed: [{ path: "vault/revisions/a.txt", error: "x" }, { path: "_RESTORE cAdtree.html", error: "y" }] })!,
    /^a version listing and the restore page couldn.t be written \(x\)$/,
  );
});
