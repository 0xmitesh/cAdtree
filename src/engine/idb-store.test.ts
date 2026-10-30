import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllConvenienceMetadata,
  getRememberedProjectBinding,
  rememberBranchConnection,
  rememberWorkspace,
  getRememberedWorkspace,
} from "./idb-store";

test("remembering and selecting a branch retains every other binding; clearing IDB removes convenience data only", async () => {
  const handle = (name: string) =>
    ({ name, kind: "directory" }) as FileSystemDirectoryHandle;
  const project = {
    projectId: "project",
    projectName: "Actuator",
    vaultHandle: handle("Vault"),
    vaultFolderName: "Vault",
  };
  await rememberBranchConnection(project, "main", handle("Main"));
  await Promise.all([
    rememberBranchConnection(project, "case-a", handle("A")),
    rememberBranchConnection(project, "case-b", handle("B")),
  ]);
  await rememberBranchConnection(project, "main");
  const saved = (await getRememberedProjectBinding("project"))!;
  assert.equal(saved.activeBranchId, "main");
  assert.deepEqual(saved.workingFolderNames, {
    main: "Main",
    "case-a": "A",
    "case-b": "B",
  });
  assert.deepEqual(Object.keys(saved.branchWorkingHandles).sort(), [
    "case-a",
    "case-b",
    "main",
  ]);
  await rememberBranchConnection(project, "case-a", handle("Replacement A"));
  assert.deepEqual(
    (await getRememberedProjectBinding("project"))!.workingFolderNames,
    { main: "Main", "case-a": "Replacement A", "case-b": "B" },
  );
  await clearAllConvenienceMetadata();
  assert.equal(await getRememberedProjectBinding("project"), null);
});

test("managed convenience storage remembers one root and preferences, with no authoritative project or branch catalogue", async () => {
  const rootHandle = {
    name: "Workbench",
    kind: "directory",
  } as FileSystemDirectoryHandle;
  await rememberWorkspace({
    workspaceId: "workspace",
    name: "Workbench",
    rootHandle,
    projectPath: "projects/actuator-id",
    activeBranchId: "branch-main",
  });
  const binding = await getRememberedWorkspace();
  assert.deepEqual(
    Object.keys(binding!).sort(),
    [
      "workspaceId",
      "name",
      "rootHandle",
      "projectPath",
      "activeBranchId",
    ].sort(),
  );
  assert.equal(binding!.rootHandle.name, "Workbench");
  await clearAllConvenienceMetadata();
  assert.equal(await getRememberedWorkspace(), null);
});
