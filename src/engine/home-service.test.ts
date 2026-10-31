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
  assert.notEqual(a.directory.toLowerCase(), b.directory.toLowerCase());
  assert.match(a.directory, /^Client ABC-/);
  assert.notEqual(
    a.workspace.identity.workspaceId,
    b.workspace.identity.workspaceId,
  );
  assert.equal((await openHome(root)).workspaces.length, 2);
});

test("workspace names allocate safe readable locations including Unicode, reserved names, separators and leading dots", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  for (const name of ["..Client ABC", "CON", "Client/ABC", ".", "தமிழ்"]) {
    const created = await createHomeWorkspace(home, name);
    assert.ok(!created.directory.startsWith("."));
    assert.ok(!created.directory.includes("/"));
    assert.equal(created.workspace.identity.name, name);
  }
  assert.ok(
    (await openHome(home)).workspaces.every((e) => e.status === "ready"),
  );
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
