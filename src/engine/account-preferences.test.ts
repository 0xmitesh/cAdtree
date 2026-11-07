import "fake-indexeddb/auto";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryFileSystemAdapter } from "./fs-adapter";
import { nativeDirectory } from "../../tests/native-fs";
import {
  clearAllConvenienceMetadata, setConvenienceAccountScope,
  rememberHome, getRememberedHome, rememberWorkspace, getRememberedWorkspace,
  saveWorkspacePath, getWorkspacePath, rememberBranchConnection,
  getRememberedProjectBinding, listRememberedProjectBindings,
} from "./idb-store";

beforeEach(async () => {
  setConvenienceAccountScope("default");
  await clearAllConvenienceMetadata();
});
afterEach(async () => {
  await clearAllConvenienceMetadata();
  setConvenienceAccountScope("default");
});

test("accounts retain separate homes, paths and branch handles even for the same project identity", async () => {
  const a = nativeDirectory(new InMemoryFileSystemAdapter("A"));
  const b = nativeDirectory(new InMemoryFileSystemAdapter("B"));
  const project = { projectId: "same-project", projectName: "Bracket", vaultHandle: a, vaultFolderName: "Vault" };
  setConvenienceAccountScope("alice");
  await rememberHome({ homeId: "home-a", name: "A", rootHandle: a });
  await rememberWorkspace({ workspaceId: "workspace", name: "A", rootHandle: a });
  await saveWorkspacePath("workspace", "D:\\Alice", a);
  await rememberBranchConnection(project, "main", a);

  setConvenienceAccountScope(null);
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getRememberedWorkspace(), null);
  assert.equal(await getWorkspacePath("workspace"), "");
  assert.equal(await getRememberedProjectBinding(project.projectId), null);
  assert.deepEqual(await listRememberedProjectBindings(), []);

  setConvenienceAccountScope("bob");
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getRememberedWorkspace(), null);
  assert.equal(await getWorkspacePath("workspace"), "");
  assert.equal(await getRememberedProjectBinding(project.projectId), null);
  await rememberHome({ homeId: "home-b", name: "B", rootHandle: b });
  await rememberWorkspace({ workspaceId: "workspace", name: "B", rootHandle: b });
  await saveWorkspacePath("workspace", "E:\\Bob", b);
  await rememberBranchConnection({ ...project, vaultHandle: b }, "case-b", b);
  assert.deepEqual((await getRememberedProjectBinding(project.projectId))!.workingFolderNames, { "case-b": "B" });

  setConvenienceAccountScope("alice");
  assert.equal((await getRememberedHome())!.homeId, "home-a");
  assert.equal((await getRememberedWorkspace())!.name, "A");
  assert.equal(await getWorkspacePath("workspace", a), "D:\\Alice");
  assert.equal(await getWorkspacePath("workspace", b), "");
  assert.deepEqual((await listRememberedProjectBindings())[0].workingFolderNames, { main: "A" });
});

test("first sign-in retains pre-signup home and path shortcuts without exposing them to the next account", async () => {
  const root = nativeDirectory(new InMemoryFileSystemAdapter("Existing home"));
  await rememberHome({ homeId: "legacy-home", name: root.name, rootHandle: root });
  await rememberWorkspace({ workspaceId: "legacy-workspace", name: "Existing workspace", rootHandle: root });
  await saveWorkspacePath("legacy-home", "D:\\Existing home", root);
  setConvenienceAccountScope("alice");
  assert.equal((await getRememberedHome())!.homeId, "legacy-home");
  assert.equal((await getRememberedWorkspace())!.workspaceId, "legacy-workspace");
  assert.equal(await getWorkspacePath("legacy-home", root), "D:\\Existing home");
  setConvenienceAccountScope("bob");
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getRememberedWorkspace(), null);
  assert.equal(await getWorkspacePath("legacy-home", root), "");
  setConvenienceAccountScope("alice");
  assert.equal((await getRememberedHome())!.name, "Existing home");
  assert.equal(await getWorkspacePath("legacy-home", root), "D:\\Existing home");
});
