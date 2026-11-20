import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { nativeDirectory } from '../../tests/native-fs';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import {
  clearAllConvenienceMetadata,
  getRememberedProjectBinding,
  rememberBranchConnection,
  rememberWorkspace,
  getRememberedWorkspace,
  getWorkspaceWindowsPath,
  saveWorkspaceWindowsPath,
  rememberHome,
  getRememberedHome,
  bindWorkspaceWindowsPathToRoot,
} from "./idb-store";

test("remembering and selecting a case retains every other binding; clearing IDB removes convenience data only", async () => {
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

test("retained workspace path preferences follow their original handle and cannot be reused by relocated copies", async () => {
  await clearAllConvenienceMetadata();
  const original = nativeDirectory(new InMemoryFileSystemAdapter('Original workspace'));
  const relocated = nativeDirectory(new InMemoryFileSystemAdapter('Managed copy'));
  const match = (name: string) => name === 'Original workspace' ? original : relocated;
  await saveWorkspaceWindowsPath("workspace-copied", "D:\\Original workspace");
  await rememberWorkspace({ workspaceId: 'workspace-copied', rootHandle: original, name: original.name });
  await bindWorkspaceWindowsPathToRoot("workspace-copied", original);
  assert.equal(
    await getWorkspaceWindowsPath(
      "workspace-copied",
      match("Original workspace"),
    ),
    "D:\\Original workspace",
  );
  assert.equal(
    await getWorkspaceWindowsPath("workspace-copied", match("Managed copy")),
    "",
  );
  await saveWorkspaceWindowsPath("workspace-copied", "E:\\Managed copy", relocated);
  assert.equal(
    await getWorkspaceWindowsPath("workspace-copied", match("Managed copy")),
    "E:\\Managed copy",
  );
  assert.equal(
    await getWorkspaceWindowsPath(
      "workspace-copied",
      match("Original workspace"),
    ),
    "",
  );
});

test("home access and last context are convenience data; home Windows roots stay separate from retained workspace roots", async () => {
  await clearAllConvenienceMetadata();
  const rootHandle = {
    name: "Cadtree",
    kind: "directory",
  } as FileSystemDirectoryHandle;
  await rememberHome({
    homeId: "home-one",
    name: "Cadtree",
    rootHandle,
    workspaceId: "workspace-one",
    projectPath: "projects/one",
    activeBranchId: "case-a",
  });
  await saveWorkspaceWindowsPath("home-one", "D:\\Cadtree");
  await saveWorkspaceWindowsPath("workspace-one", "E:\\Original workspace");
  assert.equal((await getRememberedHome())!.activeBranchId, "case-a");
  assert.equal(await getWorkspaceWindowsPath("home-one"), "D:\\Cadtree");
  assert.equal(
    await getWorkspaceWindowsPath("workspace-one"),
    "E:\\Original workspace",
  );
  await clearAllConvenienceMetadata();
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getWorkspaceWindowsPath("home-one"), "");
});

test("Windows location preferences are separate per workspace identity and disappear when convenience data is cleared", async () => {
  await clearAllConvenienceMetadata();
  await saveWorkspaceWindowsPath("one", '"d:\\Workspace One\\"');
  await saveWorkspaceWindowsPath("two", "\\\\server\\share\\Two");
  assert.equal(await getWorkspaceWindowsPath("one"), "D:\\Workspace One");
  assert.equal(await getWorkspaceWindowsPath("two"), "\\\\server\\share\\Two");
  await assert.rejects(saveWorkspaceWindowsPath("one", "../relative"));
  assert.equal(await getWorkspaceWindowsPath("one"), "D:\\Workspace One");
  await saveWorkspaceWindowsPath("one", "");
  assert.equal(await getWorkspaceWindowsPath("one"), "");
  assert.equal(await getWorkspaceWindowsPath("two"), "\\\\server\\share\\Two");
  await clearAllConvenienceMetadata();
  assert.equal(await getWorkspaceWindowsPath("two"), "");
  assert.equal(await getRememberedWorkspace(), null);
});

test("managed convenience storage remembers one root and preferences, with no authoritative project or case catalogue", async () => {
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
