import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { nativeDirectory } from '../../tests/native-fs';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import {
  clearAllConvenienceMetadata,
  rememberWorkspace,
  getRememberedWorkspace,
  getWorkspacePath,
  saveWorkspacePath,
  rememberHome,
  getRememberedHome,
  bindWorkspacePathToRoot,
} from "./idb-store";

test("retained workspace path preferences follow their original handle and cannot be reused by relocated copies", async () => {
  await clearAllConvenienceMetadata();
  const original = nativeDirectory(new InMemoryFileSystemAdapter('Original workspace'));
  const relocated = nativeDirectory(new InMemoryFileSystemAdapter('Managed copy'));
  const match = (name: string) => name === 'Original workspace' ? original : relocated;
  await saveWorkspacePath("workspace-copied", "D:\\Original workspace");
  await rememberWorkspace({ workspaceId: 'workspace-copied', rootHandle: original, name: original.name });
  await bindWorkspacePathToRoot("workspace-copied", original);
  assert.equal(
    await getWorkspacePath(
      "workspace-copied",
      match("Original workspace"),
    ),
    "D:\\Original workspace",
  );
  assert.equal(
    await getWorkspacePath("workspace-copied", match("Managed copy")),
    "",
  );
  await saveWorkspacePath("workspace-copied", "E:\\Managed copy", relocated);
  assert.equal(
    await getWorkspacePath("workspace-copied", match("Managed copy")),
    "E:\\Managed copy",
  );
  assert.equal(
    await getWorkspacePath(
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
  await saveWorkspacePath("home-one", "D:\\Cadtree");
  await saveWorkspacePath("workspace-one", "E:\\Original workspace");
  assert.equal((await getRememberedHome())!.activeBranchId, "case-a");
  assert.equal(await getWorkspacePath("home-one"), "D:\\Cadtree");
  assert.equal(
    await getWorkspacePath("workspace-one"),
    "E:\\Original workspace",
  );
  await clearAllConvenienceMetadata();
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getWorkspacePath("home-one"), "");
});

test("Windows location preferences are separate per workspace identity and disappear when convenience data is cleared", async () => {
  await clearAllConvenienceMetadata();
  await saveWorkspacePath("one", '"d:\\Workspace One\\"');
  await saveWorkspacePath("two", "\\\\server\\share\\Two");
  assert.equal(await getWorkspacePath("one"), "D:\\Workspace One");
  assert.equal(await getWorkspacePath("two"), "\\\\server\\share\\Two");
  await assert.rejects(saveWorkspacePath("one", "../relative"));
  assert.equal(await getWorkspacePath("one"), "D:\\Workspace One");
  await saveWorkspacePath("one", "");
  assert.equal(await getWorkspacePath("one"), "");
  assert.equal(await getWorkspacePath("two"), "\\\\server\\share\\Two");
  await clearAllConvenienceMetadata();
  assert.equal(await getWorkspacePath("two"), "");
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
