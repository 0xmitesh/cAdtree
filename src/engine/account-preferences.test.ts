import "fake-indexeddb/auto";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryFileSystemAdapter } from "./fs-adapter";
import { nativeDirectory } from "../../tests/native-fs";
import {
  clearAllConvenienceMetadata,
  rememberHome, getRememberedHome, rememberWorkspace, getRememberedWorkspace,
  saveWorkspacePath, getWorkspacePath, rememberBranchConnection,
  getRememberedProjectBinding, listRememberedProjectBindings,
} from "./idb-store";

beforeEach(async () => { await clearAllConvenienceMetadata(); });
afterEach(async () => { await clearAllConvenienceMetadata(); });

test("the browser keeps one set of remembered homes, workspaces, addresses and branch handles", async () => {
  const a = nativeDirectory(new InMemoryFileSystemAdapter("A"));
  const b = nativeDirectory(new InMemoryFileSystemAdapter("B"));
  const project = { projectId: "project-1", projectName: "Bracket", vaultHandle: a, vaultFolderName: "Vault" };
  assert.equal(await getRememberedHome(), null);
  assert.equal(await getRememberedWorkspace(), null);
  assert.equal(await getWorkspacePath("workspace"), "");
  assert.equal(await getRememberedProjectBinding(project.projectId), null);
  assert.deepEqual(await listRememberedProjectBindings(), []);

  await rememberHome({ homeId: "home-a", name: "A", rootHandle: a });
  await rememberWorkspace({ workspaceId: "workspace", name: "A", rootHandle: a });
  await saveWorkspacePath("workspace", "D:\\Alice", a);
  await rememberBranchConnection(project, "main", a);
  assert.equal((await getRememberedHome())!.homeId, "home-a");
  assert.equal((await getRememberedWorkspace())!.name, "A");
  assert.equal(await getWorkspacePath("workspace", a), "D:\\Alice");
  assert.equal(await getWorkspacePath("workspace", b), "", "an address is only returned for the folder it was saved with");
  assert.deepEqual((await listRememberedProjectBindings())[0].workingFolderNames, { main: "A" });

  await rememberBranchConnection({ ...project, vaultHandle: b }, "case-b", b);
  assert.deepEqual((await getRememberedProjectBinding(project.projectId))!.workingFolderNames, { main: "A", "case-b": "B" });
  await rememberHome({ homeId: "home-b", name: "B", rootHandle: b });
  assert.equal((await getRememberedHome())!.homeId, "home-b");
});

test("browser data saved before the account scope was removed still opens; old account-prefixed copies are ignored", async () => {
  const root = nativeDirectory(new InMemoryFileSystemAdapter("Existing home"));
  const other = nativeDirectory(new InMemoryFileSystemAdapter("Other home"));
  await rememberHome({ homeId: "legacy-home", name: root.name, rootHandle: root });
  await rememberWorkspace({ workspaceId: "legacy-workspace", name: "Existing workspace", rootHandle: root });
  await saveWorkspacePath("legacy-home", "D:\\Existing home", root);
  // A copy under an account-prefixed key, as an earlier version wrote it, is never read.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cadtree_convenience_v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("ui_preferences", "readwrite");
    tx.objectStore("ui_preferences").put({ homeId: "account-home", name: "Other home", rootHandle: other }, "account:alice:home");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
  assert.equal((await getRememberedHome())!.homeId, "legacy-home");
  assert.equal((await getRememberedWorkspace())!.workspaceId, "legacy-workspace");
  assert.equal(await getWorkspacePath("legacy-home", root), "D:\\Existing home");
});
