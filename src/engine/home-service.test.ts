import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import {
  createHome,
  openHome,
  createHomeWorkspace,
  bringWorkspaceIntoHome,
} from "./home-service";
import {
  createWorkspace,
  importProject,
  createManagedBranch,
  managementChecksum,
  openWorkspace,
  recoverManagedCopy,
} from "./workspace-service";
import {
  readVerifiedInventory,
  inventorySignature,
  copyVerifiedTree,
} from "./copy-service";
import { captureRevision } from "./revision-service";
import { scanBranchChanges } from "./scanner";
import { getBranchBaseline } from "./branch-state";
import { hashString } from "./hash";
import {
  resolveHomeFilePath,
  resolveWorkingFilePath,
  resolveRecoveredFilePath,
} from "./path-shortcuts";
import { composeWindowsFilePaths } from "../utils/windows-path";
import { getObjectPathSegments } from "./object-store";
const notes = { problem: "", modification: "", observations: "" };
const snapshot = async (dir: FileSystemDirectoryAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));
async function source() {
  const root = new InMemoryFileSystemAdapter("Original");
  await root.writeFileBytes(
    ["Parts", "Pärt.SLDPRT"],
    new Uint8Array([0, 255, 16]),
  );
  await root.getDirectory(["Empty", "Nested"], { create: true });
  return root;
}
async function existing() {
  const root = new InMemoryFileSystemAdapter("cam 2");
  await createWorkspace(root);
  let project = await importProject(root, await source(), "Actuator");
  const first = await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    {
      branchId: "branch-main",
      summary: "Baseline",
      notes,
      workingFolders: project.workingFolders,
    },
  );
  project = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId,
    name: "Case A",
    reason: "Test alternative",
  });
  await project.workingFolders[
    project.vaultState.branches.find((b) => !b.isMain)!.branchId
  ]!.writeFileText(["Uncaptured.txt"], "latest alternative");
  await project.workingFolders["branch-main"]!.writeFileText(
    ["Uncaptured main.txt"],
    "latest Main",
  );
  return { root, project, first };
}
test("three workspaces with multiple projects rediscover from disk alone; scans and histories stay in branch leaves", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(root);
  const ids = new Set<string>();
  for (const name of ["Personal SolidWorks", "Client ABC", "AutoCAD"]) {
    const result = await createHomeWorkspace(root, name);
    ids.add(result.workspace.identity.workspaceId);
    for (const projectName of ["Actuator", "Valve"]) {
      const p = await importProject(
        result.workspace.root,
        await source(),
        projectName,
      );
      const saved = await captureRevision(
        p.workingFolders["branch-main"]!,
        p.vaultDir,
        {
          branchId: "branch-main",
          summary: name,
          notes,
          workingFolders: p.workingFolders,
        },
      );
      assert.equal(saved.revision.manifest.displayNumber, 1);
    }
  }
  assert.equal(ids.size, 3);
  for (const e of (await openHome(root)).workspaces) {
    assert.equal(e.status, "ready");
    assert.equal(e.workspace!.projects.length, 2);
    for (const p of e.workspace!.projects) {
      assert.equal(p.project!.vaultState.revisions[0].manifest.summary, e.name);
      const scan = await scanBranchChanges(
        p.project!.workingFolders["branch-main"]!,
        "branch-main",
        null,
      );
      assert.deepEqual(
        scan.added.map((f) => f.path),
        ["Parts/Pärt.SLDPRT"],
      );
    }
  }
});
test("workspace adoption preserves every source byte, relative layout, identity, empty directory, and uncaptured branch edit", async () => {
  const { root: original, project, first } = await existing();
  const before = await snapshot(original);
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const adopted = await bringWorkspaceIntoHome(home, original);
  assert.equal(await snapshot(adopted.workspace.root), before);
  assert.equal(await snapshot(original), before);
  const p = adopted.workspace.projects[0].project!;
  assert.equal(p.record.projectId, project.record.projectId);
  assert.deepEqual(p.workingPaths, project.workingPaths);
  assert.equal(p.vaultState.revisions.length, 1);
  const scan = await scanBranchChanges(
    p.workingFolders["branch-main"]!,
    "branch-main",
    getBranchBaseline(p.vaultState, "branch-main"),
  );
  assert.ok(scan.added.some((f) => f.path === "Uncaptured main.txt"));
  const capture = await captureRevision(
    p.workingFolders["branch-main"]!,
    p.vaultDir,
    {
      branchId: "branch-main",
      summary: "After move",
      notes,
      workingFolders: p.workingFolders,
    },
  );
  assert.equal(capture.revision.manifest.displayNumber, 2);
  assert.equal(
    capture.revision.manifest.parentRevisionId,
    first.revision.manifest.revisionId,
  );
  assert.equal(await snapshot(original), before);
  await assert.rejects(
    bringWorkspaceIntoHome(home, original),
    /already has a retained managed registration/,
  );
  assert.equal((await openHome(home)).workspaces.length, 1);
});
test("duplicate display names allocate independent readable child folders under concurrent registration", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(root);
  const [a, b] = await Promise.all([
    createHomeWorkspace(root, "Client ABC"),
    createHomeWorkspace(root, "Client ABC"),
  ]);
  assert.deepEqual([a.directory, b.directory].sort(), [
    "Client ABC",
    "Client ABC (2)",
  ]);
  assert.notEqual(
    a.workspace.identity.workspaceId,
    b.workspace.identity.workspaceId,
  );
  assert.equal((await openHome(root)).workspaces.length, 2);
});

test("workspace names allocate safe readable locations including Unicode, reserved names, separators and leading dots", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const expected: Record<string, string> = {
    "..Client ABC": "Client ABC",
    CON: "CON (2)",
    "Client/ABC": "Client-ABC",
    ".": "Workspace",
    "தமிழ்": "தமிழ்",
  };
  for (const name of Object.keys(expected)) {
    const created = await createHomeWorkspace(home, name);
    assert.equal(created.directory, expected[name]);
    assert.equal(created.workspace.identity.name, name);
  }
  assert.ok(
    (await openHome(home)).workspaces.every((e) => e.status === "ready"),
  );
});
test("workspace folder names are exact, case-insensitively unique, and never reuse an incomplete registration", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const first = await createHomeWorkspace(home, "Client ABC");
  assert.equal(first.directory, "Client ABC");
  const second = await createHomeWorkspace(home, "Client ABC");
  assert.equal(second.directory, "Client ABC (2)");

  const other = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(other);
  await other.getDirectory(["client abc"], { create: true });
  assert.equal(
    (await createHomeWorkspace(other, "Client ABC")).directory,
    "Client ABC (2)",
  );

  const failing = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(failing);
  failing.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("Retry me")) throw new Error("Disk write failed");
    },
  });
  await assert.rejects(createHomeWorkspace(failing, "Retry me"));
  failing.setHooks({ onBeforeWrite: undefined });
  const entries = (await openHome(failing)).workspaces;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "incomplete");
  assert.equal(entries[0].directory, "Retry me");
  const retry = await createHomeWorkspace(failing, "Retry me");
  assert.equal(retry.directory, "Retry me (2)");
});
test("home setup refuses unrelated populated storage, overlap, unsupported schemas, and permission loss without writes", async () => {
  const root = new InMemoryFileSystemAdapter("Populated");
  await root.writeFileText(["CAD.bin"], "untouched");
  const before = await snapshot(root);
  await assert.rejects(createHome(root), /empty dedicated folder/);
  assert.equal(await snapshot(root), before);
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const a = await createHomeWorkspace(home, "A");
  await assert.rejects(
    bringWorkspaceIntoHome(home, a.workspace.root),
    /Isolation violation/,
  );
  const id = JSON.parse(await home.readFileText([".cadtree-home.json"]));
  id.schemaVersion = 99;
  id.payloadSha256 = managementChecksum(id);
  await home.writeFileText([".cadtree-home.json"], JSON.stringify(id));
  await assert.rejects(openHome(home), /Unsupported/);
  home.setHooks({ readPermission: "denied" });
  await assert.rejects(openHome(home), /Permission denied/);
});

test("a changed home identity cannot receive writes through a stale app connection", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  const first = await createHome(home);
  const other = new InMemoryFileSystemAdapter("Another home");
  await createHome(other);
  await home.writeFileText(
    [".cadtree-home.json"],
    await other.readFileText([".cadtree-home.json"]),
  );
  const before = await snapshot(home);
  await assert.rejects(
    createHomeWorkspace(home, "Blocked", {
      expectedHomeId: first.identity.homeId,
    }),
    /identity changed/,
  );
  assert.equal(await snapshot(home), before);
});
test("missing workspaces and substituted identities remain unavailable and never get recreated or rebound", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const a = await createHomeWorkspace(home, "A");
  const b = await createHomeWorkspace(home, "B");
  await home.removeEntry([a.directory], { recursive: true });
  await b.workspace.root.writeFileText(
    [".cadtree-workspace.json"],
    await a.workspace.root.readFileText([".cadtree-workspace.json"]),
  );
  const before = await snapshot(home);
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 2);
  assert.ok(
    read.workspaces.every((e) => e.status === "damaged" && !e.workspace),
  );
  assert.equal(await home.hasDirectory([a.directory]), false);
  assert.equal(await snapshot(home), before);
});
test("corrupt mappings, duplicate registrations, and unregistered workspace copies are visible without guessed binding", async () => {
  for (const mode of ["unsafe", "duplicate", "orphan", "checksum"]) {
    const home = new InMemoryFileSystemAdapter("Cadtree");
    await createHome(home);
    const a = await createHomeWorkspace(home, "A");
    const records = await home.getDirectory([".cadtree-home", "workspaces"]);
    const file = (await records.listEntries()).find(
      (f) => !f.name.endsWith(".ready.json"),
    )!.name;
    const record = JSON.parse(await records.readFileText([file]));
    if (mode === "orphan")
      await copyVerifiedTree(
        a.workspace.root,
        await home.getDirectory(["Unregistered copy"], { create: true }),
      );
    else {
      if (mode === "unsafe") record.directory = "../outside";
      if (mode === "duplicate") record.registrationId = "duplicate";
      if (mode === "checksum") record.payloadSha256 = "invalid";
      else record.payloadSha256 = managementChecksum(record);
      const text = JSON.stringify(record);
      const name = mode === "duplicate" ? "duplicate.json" : file;
      await records.writeFileText([name], text);
      const marker = {
        schemaVersion: 1,
        registrationId: record.registrationId,
        recordSha256: hashString(text),
      };
      await records.writeFileText(
        [`${record.registrationId}.ready.json`],
        JSON.stringify({
          ...marker,
          payloadSha256: managementChecksum(marker),
        }),
      );
    }
    const before = await snapshot(home);
    const read = await openHome(home);
    assert.ok(
      read.workspaces.some((e) => e.status !== "ready" && !e.workspace),
    );
    if (mode === "duplicate")
      assert.ok(read.workspaces.every((e) => e.status === "duplicate"));
    assert.equal(await snapshot(home), before);
  }
});
test("cancellation, source instability, disk failure and interrupted ready publication retain incomplete destinations and originals", async () => {
  for (const mode of ["cancel", "change", "write", "publish"]) {
    const { root: original } = await existing();
    const before = await snapshot(original);
    const home = new InMemoryFileSystemAdapter("Cadtree");
    await createHome(home);
    const abort = new AbortController();
    let once = false;
    home.setHooks({
      onBeforeWrite: (path) => {
        if (
          (mode === "write" && path.includes("Pärt")) ||
          (mode === "publish" &&
            path.includes(".cadtree-home/workspaces/") &&
            path.endsWith(".ready.json"))
        )
          throw new Error("Simulated disk failure");
      },
    });
    await assert.rejects(
      bringWorkspaceIntoHome(home, original, {
        signal: abort.signal,
        onProgress: (p) => {
          if (!once && p.phase === "restoring_files") {
            once = true;
            if (mode === "cancel") abort.abort();
            if (mode === "change")
              void original.writeFileText(
                ["Added during copy"],
                "changed externally",
              );
          }
        },
      }),
      /Destination retained/,
    );
    home.setHooks({ onBeforeWrite: undefined });
    const read = await openHome(home);
    assert.equal(read.workspaces.length, 1);
    assert.equal(read.workspaces[0].status, "incomplete");
    assert.ok(!read.workspaces[0].workspace);
    if (mode !== "change") assert.equal(await snapshot(original), before);
    const retry = await bringWorkspaceIntoHome(home, original);
    assert.notEqual(retry.directory, read.workspaces[0].directory);
    assert.match(retry.directory, / \(2\)$/);
    const reopened = await openHome(home);
    assert.equal(reopened.workspaces.length, 2);
    assert.equal(
      reopened.workspaces.filter((e) => e.status === "ready").length,
      1,
    );
    assert.equal(
      reopened.workspaces.filter((e) => e.status === "incomplete").length,
      1,
    );
  }
});
test("ready write acknowledgement loss reopens as published without duplicating adoption", async () => {
  const { root: original } = await existing();
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  home.setHooks({
    onAfterWrite: (path) => {
      if (
        path.includes(".cadtree-home/workspaces/") &&
        path.endsWith(".ready.json")
      )
        throw new Error("Lost acknowledgement");
    },
  });
  await bringWorkspaceIntoHome(home, original);
  home.setHooks({ onAfterWrite: undefined });
  assert.equal((await openHome(home)).workspaces[0].status, "ready");
  await assert.rejects(
    bringWorkspaceIntoHome(home, original),
    /retained managed registration/,
  );
});

test("workspace migration rejects corrupt historical objects without modifying the source", async () => {
  const { root: original, project, first } = await existing();
  const file = first.revision.manifest.files[0];
  await project.vaultDir.writeFileBytes(
    getObjectPathSegments(file.sha256),
    new Uint8Array([99]),
  );
  const before = await snapshot(original);
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  await assert.rejects(
    bringWorkspaceIntoHome(home, original),
    /damaged historical content/,
  );
  assert.equal(await snapshot(original), before);
  assert.equal((await openHome(home)).workspaces[0].status, "incomplete");
});

test("whole-workspace copying holds source project locks until verified publication", async () => {
  const { root: original, project } = await existing();
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  let capture: ReturnType<typeof captureRevision> | undefined;
  let finished = false;
  const result = await bringWorkspaceIntoHome(home, original, {
    onProgress: (progress) => {
      if (progress.phase === "restoring_files" && !capture) {
        capture = captureRevision(
          project.workingFolders["branch-main"]!,
          project.vaultDir,
          {
            branchId: "branch-main",
            summary: "Concurrent source capture",
            notes,
            workingFolders: project.workingFolders,
          },
        );
        void capture.then(() => {
          finished = true;
        });
      }
      if (progress.phase === "publishing_completion")
        assert.equal(finished, false);
    },
  });
  assert.ok(capture);
  await capture;
  assert.equal(
    result.workspace.projects[0].project!.vaultState.revisions.length,
    1,
  );
  assert.equal(
    (await openWorkspace(original)).projects[0].project!.vaultState.revisions
      .length,
    2,
  );
});
test("home paths cover adopted current, historical-branch and recovered files using the validated extra level", async () => {
  const { root: original, project, first } = await existing();
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const adopted = await bringWorkspaceIntoHome(home, original);
  const state = await openHome(home);
  const entry = state.workspaces[0];
  const p = adopted.workspace.projects[0].project!;
  for (const branchId of Object.keys(p.workingPaths)) {
    const location = await resolveHomeFilePath(
      state,
      entry,
      await resolveWorkingFilePath(
        adopted.workspace.root,
        adopted.workspace.identity.workspaceId,
        p.record.containerPath,
        branchId,
        "Parts/Pärt.SLDPRT",
      ),
    );
    assert.equal(
      composeWindowsFilePaths("D:\\Cadtree", location).folder,
      `D:\\Cadtree\\${adopted.directory}\\${p.workingPaths[branchId].replaceAll("/", "\\")}\\Parts`,
    );
  }
  const recovered = await recoverManagedCopy(
    adopted.workspace.root,
    p.record.containerPath,
    first.revision.manifest.revisionId,
    undefined,
  );
  const location = await resolveHomeFilePath(
    state,
    entry,
    await resolveRecoveredFilePath(
      adopted.workspace.root,
      adopted.workspace.identity.workspaceId,
      p.record.containerPath,
      recovered.relativePath,
      "Parts/Pärt.SLDPRT",
    ),
  );
  assert.ok(
    location.relativeDirectory.startsWith(
      `${adopted.directory}/${project.record.containerPath}/recoveries/`,
    ),
  );
  await home.removeEntry([adopted.directory], { recursive: true });
  await assert.rejects(
    resolveHomeFilePath(state, entry, {
      ...location,
      workspaceId: adopted.workspace.identity.workspaceId,
    }),
    /mapping is unavailable/,
  );
});

// The in-memory adapter has no move: recreate the tree under the new name, then remove the original.
async function renameChild(
  home: FileSystemDirectoryAdapter,
  from: string,
  to: string,
) {
  const target = await home.getDirectory([to], { create: true });
  await copyVerifiedTree(await home.getDirectory([from]), target);
  await home.removeEntry([from], { recursive: true });
}
async function homeWithProjectWorkspace(names: string[]) {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const created = [];
  for (const name of names) {
    const w = await createHomeWorkspace(home, name);
    await importProject(w.workspace.root, await source(), `Part ${name}`);
    created.push(w);
  }
  return { home, created };
}
const registrationBytes = async (home: FileSystemDirectoryAdapter) => {
  const records = await home.getDirectory([".cadtree-home", "workspaces"]);
  const out: Record<string, string> = {};
  for (const f of await records.listEntries())
    out[f.name] = await records.readFileText([f.name]);
  return out;
};

test("a renamed workspace folder is found by its workspace id, read-only, and is not listed as unregistered", async () => {
  const { home, created } = await homeWithProjectWorkspace(["Client ABC"]);
  const id = created[0].workspace.identity.workspaceId;
  const bytes = await registrationBytes(home);
  await renameChild(home, "Client ABC", "Client ABC renamed");
  const before = await snapshot(home);
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 1);
  const entry = read.workspaces[0];
  assert.equal(entry.status, "ready");
  assert.equal(entry.directory, "Client ABC renamed");
  assert.equal(entry.recordedDirectory, "Client ABC");
  assert.equal(entry.workspace?.identity.workspaceId, id);
  assert.equal(entry.workspace?.projects.length, 1);
  assert.ok(entry.workspace?.projects.every((p) => p.status === "ready"));
  assert.ok(!read.workspaces.some((e) => e.key.startsWith("unregistered:")));
  assert.deepEqual(await registrationBytes(home), bytes);
  assert.equal(await snapshot(home), before);
});

test("after a workspace folder rename the old recorded name stays taken for new workspaces", async () => {
  const { home } = await homeWithProjectWorkspace(["Client ABC"]);
  await renameChild(home, "Client ABC", "Client ABC renamed");
  const next = await createHomeWorkspace(home, "Client ABC");
  assert.equal(next.directory, "Client ABC (2)");
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 2);
  assert.ok(read.workspaces.every((e) => e.status === "ready"));
  assert.deepEqual(read.workspaces.map((e) => e.directory).sort(), [
    "Client ABC (2)",
    "Client ABC renamed",
  ]);
  assert.equal(new Set(read.workspaces.map((e) => e.workspaceId)).size, 2);
});

test("swapped workspace folders resolve to the correct folders by id", async () => {
  const { home, created } = await homeWithProjectWorkspace(["A", "B"]);
  const [a, b] = created;
  await renameChild(home, "A", "tmp");
  await renameChild(home, "B", "A");
  await renameChild(home, "tmp", "B");
  const bytes = await registrationBytes(home);
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 2);
  assert.ok(read.workspaces.every((e) => e.status === "ready"));
  const byId = (id: string) =>
    read.workspaces.find((e) => e.workspaceId === id)!;
  assert.equal(byId(a.workspace.identity.workspaceId).directory, "B");
  assert.equal(byId(b.workspace.identity.workspaceId).directory, "A");
  assert.deepEqual(await registrationBytes(home), bytes);
});

test("two copies of a workspace with the recorded folder missing are damaged and no folder is chosen", async () => {
  const { home, created } = await homeWithProjectWorkspace(["Client ABC"]);
  await renameChild(home, "Client ABC", "Copy one");
  await copyVerifiedTree(
    await home.getDirectory(["Copy one"]),
    await home.getDirectory(["Copy two"], { create: true }),
  );
  const before = await snapshot(home);
  const read = await openHome(home);
  const entry = read.workspaces.find(
    (e) => e.workspaceId === created[0].workspace.identity.workspaceId,
  )!;
  assert.equal(entry.status, "damaged");
  assert.equal(entry.workspace, undefined);
  assert.equal(entry.directory, "Client ABC");
  assert.ok(
    entry.issues.some(
      (i) =>
        i.includes("more than one folder") &&
        i.includes("Copy one") &&
        i.includes("Copy two"),
    ),
  );
  assert.equal(await snapshot(home), before);
});

test("a missing workspace folder with no identity match stays damaged", async () => {
  const { home } = await homeWithProjectWorkspace(["Client ABC"]);
  await home.removeEntry(["Client ABC"], { recursive: true });
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 1);
  assert.equal(read.workspaces[0].status, "damaged");
  assert.equal(read.workspaces[0].workspace, undefined);
  assert.equal(read.workspaces[0].directory, "Client ABC");
});

test("home paths for a project in a renamed workspace use the new folder name", async () => {
  const { home, created } = await homeWithProjectWorkspace(["Client ABC"]);
  const w = created[0];
  const p = (await openWorkspace(w.workspace.root)).projects[0].project!;
  await renameChild(home, "Client ABC", "Client ABC renamed");
  const state = await openHome(home);
  const entry = state.workspaces[0];
  const root = entry.workspace!.root;
  const location = await resolveHomeFilePath(
    state,
    entry,
    await resolveWorkingFilePath(
      root,
      w.workspace.identity.workspaceId,
      p.record.containerPath,
      "branch-main",
      "Parts/Pärt.SLDPRT",
    ),
  );
  assert.ok(location.relativeDirectory.startsWith("Client ABC renamed/"));
});

test("a recorded folder that still carries the workspace id but fails to open is never replaced by a backup copy", async () => {
  const { home, created } = await homeWithProjectWorkspace(["Client ABC"]);
  await copyVerifiedTree(
    created[0].workspace.root,
    await home.getDirectory(["Client ABC backup"], { create: true }),
  );
  // Valid .cadtree-workspace.json, but openWorkspace cannot read the projects folder.
  await home.removeEntry(["Client ABC", "projects"], { recursive: true });
  const before = await snapshot(home);
  const read = await openHome(home);
  const entry = read.workspaces.find(
    (e) => e.workspaceId === created[0].workspace.identity.workspaceId,
  )!;
  assert.equal(entry.status, "damaged");
  assert.equal(entry.workspace, undefined);
  assert.equal(entry.directory, "Client ABC");
  assert.ok(entry.issues.length > 0);
  assert.ok(!entry.issues.some((i) => i.includes("more than one folder")));
  assert.equal(await snapshot(home), before);
});

test("a recorded folder with an unreadable workspace file falls back to the single folder carrying the id", async () => {
  // Chosen behaviour: without a readable .cadtree-workspace.json the recorded folder holds no identity, so it counts as missing.
  const { home, created } = await homeWithProjectWorkspace(["Client ABC"]);
  await copyVerifiedTree(
    created[0].workspace.root,
    await home.getDirectory(["Client ABC backup"], { create: true }),
  );
  await home.writeFileText(["Client ABC", ".cadtree-workspace.json"], "{garbled");
  const read = await openHome(home);
  const entry = read.workspaces.find(
    (e) => e.workspaceId === created[0].workspace.identity.workspaceId,
  )!;
  assert.equal(entry.status, "ready");
  assert.equal(entry.directory, "Client ABC backup");
  assert.equal(entry.recordedDirectory, "Client ABC");
});

test("a case-only workspace folder rename is found by id", async () => {
  const { home } = await homeWithProjectWorkspace(["client abc"]);
  await renameChild(home, "client abc", "Client ABC");
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 1);
  assert.equal(read.workspaces[0].status, "ready");
  assert.equal(read.workspaces[0].directory, "Client ABC");
  assert.equal(read.workspaces[0].recordedDirectory, "client abc");
});

test("an incomplete registration keeps its recorded name taken and its folder is never bound to another registration", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  home.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("Retry me")) throw new Error("Disk write failed");
    },
  });
  await assert.rejects(createHomeWorkspace(home, "Retry me"));
  home.setHooks({ onBeforeWrite: undefined });
  if (await home.hasDirectory(["Retry me"]))
    await home.removeEntry(["Retry me"], { recursive: true });
  const a = await createHomeWorkspace(home, "A");
  await renameChild(home, "A", "Retry me");
  const read = await openHome(home);
  const incomplete = read.workspaces.find((e) => e.status === "incomplete")!;
  assert.equal(incomplete.directory, "Retry me");
  const entryA = read.workspaces.find(
    (e) => e.workspaceId === a.workspace.identity.workspaceId,
  )!;
  assert.equal(entryA.status, "damaged");
  assert.equal(entryA.workspace, undefined);
  assert.equal(entryA.directory, "A");
  assert.equal(
    (await createHomeWorkspace(home, "Retry me")).directory,
    "Retry me (2)",
  );
});

test("two ready registrations with the same workspace id are both duplicates and nothing is bound", async () => {
  const { home } = await homeWithProjectWorkspace(["Client ABC"]);
  const records = await home.getDirectory([".cadtree-home", "workspaces"]);
  const file = (await records.listEntries()).find(
    (f) => !f.name.endsWith(".ready.json"),
  )!.name;
  const record = JSON.parse(await records.readFileText([file]));
  record.registrationId = "second";
  record.directory = "Elsewhere";
  delete record.payloadSha256;
  record.payloadSha256 = managementChecksum(record);
  const text = JSON.stringify(record);
  await records.writeFileText(["second.json"], text);
  const marker = {
    schemaVersion: 1,
    registrationId: "second",
    recordSha256: hashString(text),
  };
  await records.writeFileText(
    ["second.ready.json"],
    JSON.stringify({ ...marker, payloadSha256: managementChecksum(marker) }),
  );
  const before = await snapshot(home);
  const read = await openHome(home);
  assert.equal(read.workspaces.length, 2);
  assert.ok(read.workspaces.every((e) => e.status === "duplicate"));
  assert.ok(read.workspaces.every((e) => !e.workspace));
  assert.equal(await snapshot(home), before);
});
