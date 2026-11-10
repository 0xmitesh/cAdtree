import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import {
  createWorkspace,
  createProject,
  openWorkspace,
  importProject,
  resolveManagedProject,
  createManagedBranch,
  recoverManagedCopy,
  adoptProject,
  WorkspaceOperationError,
  managementChecksum,
  type ManagedProject,
} from "./workspace-service";
import {
  inventorySignature,
  readVerifiedInventory,
  copyVerifiedTree,
} from "./copy-service";
import { hashString } from "./hash";
import { getObjectPathSegments } from "./object-store";
import { initializeProjectVault, openExistingVault } from "./vault-service";
import { captureRevision } from "./revision-service";
import { scanBranchChanges } from "./scanner";
import { getBranchBaseline } from "./branch-state";
import { createDesignBranch } from "./branch-service";

const notes = { problem: "", modification: "", observations: "" };
const snapshot = async (dir: FileSystemDirectoryAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));
async function cadSource(name = "Original CAD") {
  const source = new InMemoryFileSystemAdapter(name);
  await source.writeFileBytes(
    ["Model.SLDASM"],
    new Uint8Array([0, 255, 128, 19]),
  );
  await source.writeFileBytes(
    ["Parts", "Pärt.SLDPRT"],
    new Uint8Array([42, 0, 55]),
  );
  await source.writeFileBytes(["Empty.txt"], new Uint8Array());
  await source.getDirectory(["Empty directory", "Nested"], { create: true });
  return source;
}
async function save(project: ManagedProject, branchId: string, value: number) {
  const folder = project.workingFolders[branchId]!;
  await folder.writeFileBytes(
    ["Parts", "Pärt.SLDPRT"],
    new Uint8Array([value, 0, 255]),
  );
  return captureRevision(folder, project.vaultDir, {
    branchId,
    summary: `Case ${value}`,
    notes,
    workingFolders: project.workingFolders,
  });
}

test("name-only project creation reopens an empty Main, then captures CAD files normally", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  await assert.rejects(createProject(root, "  "), /name is required/);
  assert.equal((await openWorkspace(root)).projects.length, 0);
  const project = await createProject(root, " New design ");
  assert.equal(project.record.name, "New design");
  assert.equal(project.record.origin, "create");
  assert.equal(project.ready, true);
  assert.equal(project.vaultState.revisions.length, 0);
  const reopened = (await openWorkspace(root)).projects[0].project!;
  assert.equal(reopened.record.projectId, project.record.projectId);
  assert.deepEqual(await reopened.workingFolders["branch-main"]!.listEntries(), []);
  assert.ok(await root.hasDirectory([...project.record.containerPath.split("/"), "recoveries"]));
  await reopened.workingFolders["branch-main"]!.writeFileBytes(["Part.SLDPRT"], new Uint8Array([0, 255, 42]));
  const saved = await captureRevision(reopened.workingFolders["branch-main"]!, reopened.vaultDir, {
    branchId: "branch-main", summary: "First design", notes,
    workingFolders: reopened.workingFolders,
  });
  assert.equal(saved.revision.manifest.files[0].path, "Part.SLDPRT");
  assert.equal(saved.revision.manifest.parentRevisionId, null);
  assert.equal((await openWorkspace(root)).projects[0].project!.vaultState.revisions.length, 1);
});

test("new-project cancellation retains an incomplete folder and creation/import share name protection", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const abort = new AbortController();
  await assert.rejects(createProject(root, "New design", {
    signal: abort.signal,
    onProgress: (progress) => {
      if (progress.phase === "publishing_completion") abort.abort();
    },
  }), /cancelled/);
  const incomplete = (await openWorkspace(root)).projects[0];
  assert.equal(incomplete.status, "incomplete");
  const retry = await createProject(root, "New design");
  assert.equal(incomplete.containerPath, "projects/New design");
  assert.equal(retry.record.containerPath, "projects/New design (2)");
  await assert.rejects(importProject(root, await cadSource(), " new DESIGN "), /already present/);
  const race = await Promise.allSettled([
    createProject(root, "Other design"),
    importProject(root, await cadSource(), " other DESIGN "),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await openWorkspace(root)).projects.length, 3);
});

test("project folders are readable and clashing names get a counter", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const a = await createProject(root, "Packaging Gripper");
  assert.equal(a.record.containerPath, "projects/Packaging Gripper");
  const b = await createProject(root, "Packaging/Gripper");
  assert.equal(b.record.containerPath, "projects/Packaging-Gripper");
  const c = await createProject(root, "Packaging-Gripper ");
  assert.equal(c.record.containerPath, "projects/Packaging-Gripper (2)");
  const d = await importProject(root, await cadSource(), "Packaging Gripper.");
  assert.equal(d.record.containerPath, "projects/Packaging Gripper (2)");
  assert.ok(a.ready && b.ready && c.ready && d.ready);
});

test("a missing projects folder fails as a plain error, not a retained destination", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  await root.removeEntry(["projects"], { recursive: true });
  await assert.rejects(createProject(root, "Anything"), (error: Error) => {
    assert.ok(!(error instanceof WorkspaceOperationError));
    assert.doesNotMatch(error.message, /Destination retained/);
    return true;
  });
});

test("two projects import and reopen from one root with exact independent leaves and no artificial revisions", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  const [sourceA, sourceB] = await Promise.all([
    cadSource("Source A"),
    cadSource("Source B"),
  ]);
  const originals = await Promise.all([snapshot(sourceA), snapshot(sourceB)]);
  await createWorkspace(root);
  const a = await importProject(root, sourceA, "Actuator");
  const b = await importProject(root, sourceB, "Valve");
  assert.notEqual(a.record.projectId, b.record.projectId);
  assert.equal(a.vaultState.revisions.length, 0);
  assert.equal(b.vaultState.revisions.length, 0);
  assert.equal(await snapshot(a.workingFolders["branch-main"]!), originals[0]);
  assert.equal(await snapshot(b.workingFolders["branch-main"]!), originals[1]);
  assert.deepEqual(
    await Promise.all([snapshot(sourceA), snapshot(sourceB)]),
    originals,
  );
  const reopened = await openWorkspace(root); // No IndexedDB or per-branch handles exist.
  assert.equal(reopened.projects.length, 2);
  assert.ok(reopened.projects.every((entry) => entry.status === "ready"));
  for (const entry of reopened.projects) {
    assert.ok(entry.project!.workingFolders["branch-main"]);
    const scan = await scanBranchChanges(
      entry.project!.workingFolders["branch-main"]!,
      "branch-main",
      null,
    );
    assert.equal(scan.added.length, 3);
    assert.ok(
      !scan.added.some((file) => /vault|\.cadtree|recoveries/.test(file.path)),
    );
  }
});

test("managed Main and three cases diverge with automatic branch/recovery destinations and branch-only inventories", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  let project = await importProject(root, await cadSource(), "Actuator");
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
  await save(project, "branch-main", 20);
  await save(project, "branch-main", 30);
  const mainBefore = await snapshot(project.workingFolders["branch-main"]!);
  const cases: string[] = [];
  for (const name of ["Case A", "Case B", "Case C"]) {
    const created = await createManagedBranch(
      root,
      project.record.containerPath,
      {
        sourceRevisionId: first.revision.manifest.revisionId,
        name,
        reason: "Explore clearance",
      },
    );
    project = created;
    cases.push(created.createdBranchId);
    assert.equal(created.vaultState.revisions.length, 3);
    assert.ok(
      created.workingPaths[created.createdBranchId].startsWith(
        project.record.containerPath + "/working/",
      ),
    );
  }
  project = await resolveManagedProject(root, project.record.containerPath);
  assert.equal(Object.keys(project.workingFolders).length, 4);
  for (const [index, id] of cases.entries()) {
    const saved = await save(project, id, 50 + index);
    assert.equal(
      saved.revision.manifest.parentRevisionId,
      first.revision.manifest.revisionId,
    );
    assert.equal(saved.revision.manifest.displayNumber, 4 + index);
    assert.equal(saved.revision.manifest.files.length, 3);
  }
  assert.equal(
    await snapshot(project.workingFolders["branch-main"]!),
    mainBefore,
  );
  const full = await recoverManagedCopy(
    root,
    project.record.containerPath,
    first.revision.manifest.revisionId,
    undefined,
  );
  const selected = await recoverManagedCopy(
    root,
    project.record.containerPath,
    first.revision.manifest.revisionId,
    ["Parts/Pärt.SLDPRT"],
  );
  assert.notEqual(full.relativePath, selected.relativePath);
  const destination = await root.getDirectory(full.relativePath.split("/"));
  assert.equal(await snapshot(destination), await snapshot(await cadSource()));
  const selectedDir = await root.getDirectory(selected.relativePath.split("/"));
  assert.deepEqual(
    (await readVerifiedInventory(selectedDir)).files.map((file) => file.path),
    ["Parts/Pärt.SLDPRT"],
  );
  assert.equal((await openExistingVault(project.vaultDir)).revisions.length, 6);
  assert.equal((await openExistingVault(project.vaultDir)).branches.length, 4);
  const resolved = (await openWorkspace(root)).projects[0].project!;
  assert.equal(Object.keys(resolved.workingFolders).length, 4);
  assert.ok(
    (
      await readVerifiedInventory(resolved.workingFolders["branch-main"]!)
    ).files.every((file) => !file.path.includes("recoveries")),
  );
});

test("workspace and mapping validation never adopt unrelated directories, recreate missing leaves, or bind by names", async () => {
  const populated = new InMemoryFileSystemAdapter("Unrelated");
  await populated.writeFileText(["User.txt"], "Retain me");
  await assert.rejects(createWorkspace(populated), /empty folder/);
  await assert.rejects(openWorkspace(populated));
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await importProject(root, await cadSource(), "Actuator");
  const path = project.workingPaths["branch-main"];
  await root.removeEntry(path.split("/"), { recursive: true });
  const reopened = await openWorkspace(root);
  assert.equal(reopened.projects[0].status, "damaged");
  assert.ok(
    reopened.projects[0].issues.some((issue) =>
      issue.includes("No folder was recreated"),
    ),
  );
  assert.equal(await root.hasDirectory(path.split("/")), false);
  await assert.rejects(
    createManagedBranch(root, project.record.containerPath, {
      sourceRevisionId: "none",
      name: "Blocked",
      reason: "No connection",
    }),
    /read-only/,
  );
  const container = await root.getDirectory(
    project.record.containerPath.split("/"),
  );
  const mappingPath = [".cadtree", "branches", "branch-main.json"];
  const mapping = JSON.parse(await container.readFileText(mappingPath));
  for (const workingPath of [
    "../escape",
    "/absolute",
    project.record.containerPath + "/vault",
    project.record.containerPath + "/working",
  ]) {
    const modified = { ...mapping, workingPath };
    modified.payloadSha256 = managementChecksum(modified);
    await container.writeFileText(mappingPath, JSON.stringify(modified));
    const state = await resolveManagedProject(
      root,
      project.record.containerPath,
    );
    assert.ok(state.issues.length);
    assert.equal(state.workingFolders["branch-main"], undefined);
  }
});

test("import failures and source instability remain incomplete; retry uses another fresh container", async () => {
  for (const failure of ["cancel", "source-change", "read", "write"]) {
    const root = new InMemoryFileSystemAdapter("Workspace");
    await createWorkspace(root);
    const source = await cadSource();
    const abort = new AbortController();
    let once = false;
    if (failure === "read") source.setHooks({ readPermission: "denied" });
    root.setHooks({
      onBeforeWrite: async (path) => {
        if (!once && path.endsWith("Model.SLDASM")) {
          once = true;
          if (failure === "source-change")
            await source.writeFileBytes(
              ["Parts", "Pärt.SLDPRT"],
              new Uint8Array([99, 99, 99]),
            );
          if (failure === "write") throw new Error("Disk write failed");
        }
      },
    });
    await assert.rejects(
      importProject(root, source, "Retry project", {
        signal: abort.signal,
        onProgress: (progress) => {
          if (failure === "cancel" && progress.phase === "restoring_files")
            abort.abort();
        },
      }),
    );
    const failed = await openWorkspace(root);
    // Import classification reads metadata before allocating a destination.
    assert.equal(failed.projects.length, failure === 'read' ? 0 : 1);
    if (failure !== 'read') assert.equal(failed.projects[0].status, "incomplete");
    source.setHooks({ readPermission: "granted" });
    root.setHooks({ onBeforeWrite: undefined });
    const retry = await importProject(root, source, "Retry project");
    assert.notEqual(
      retry.record.containerPath,
      failed.projects[0]?.containerPath,
    );
    // "read" fails during source classification, before any destination exists,
    // so nothing is left behind and the retry gets the plain name.
    assert.equal(
      retry.record.containerPath,
      failure === "read" ? "projects/Retry project" : "projects/Retry project (2)",
    );
    assert.equal(
      (await root.getDirectory(["projects"])).listEntries instanceof Function,
      true,
    );
    assert.equal(
      (await openWorkspace(root)).projects.filter(
        (entry) => entry.status === "ready",
      ).length,
      1,
    );
  }
});

test("import rejects workspace/source overlap and concurrent project name races without overwrites", async () => {
  const source = await cadSource();
  const root = await source.getDirectory(["Workspace"], { create: true });
  await createWorkspace(root);
  await assert.rejects(
    importProject(root, source, "Unsafe"),
    /Isolation violation/,
  );
  await assert.rejects(importProject(root, root, "Unsafe"), /same directory/);
  const detached = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(detached);
  const results = await Promise.allSettled([
    importProject(detached, await cadSource(), "Same"),
    importProject(detached, await cadSource(), " same "),
  ]);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal((await openWorkspace(detached)).projects.length, 1);
});

test("adoption preserves exact vault records and uncaptured working edits while retaining original locations", async () => {
  const main = await cadSource();
  const vault = new InMemoryFileSystemAdapter("Old vault");
  await initializeProjectVault(main, vault, "Legacy actuator");
  const first = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Baseline",
    notes,
  });
  const branch = await createDesignBranch({
    vaultDir: vault,
    destinationParent: new InMemoryFileSystemAdapter("Legacy cases"),
    sourceRevisionId: first.revision.manifest.revisionId,
    name: "Case A",
    reason: "Alternative",
    workingFolders: { "branch-main": main },
  });
  const folders = {
    "branch-main": main,
    [branch.branch.branchId]: branch.workingDir,
  };
  await main.writeFileBytes(["Uncaptured.bin"], new Uint8Array([9, 0, 255]));
  await branch.workingDir.writeFileBytes(
    ["Parts", "Pärt.SLDPRT"],
    new Uint8Array([17, 17, 17]),
  );
  const originals = await Promise.all([
    snapshot(vault),
    snapshot(main),
    snapshot(branch.workingDir),
  ]);
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const adopted = await adoptProject(root, vault, folders);
  assert.equal(
    adopted.record.containerPath,
    "projects/Legacy actuator",
  );
  assert.equal(
    adopted.workingPaths["branch-main"],
    "projects/Legacy actuator/working/main",
  );
  assert.equal(
    adopted.workingPaths[branch.branch.branchId],
    "projects/Legacy actuator/working/Case A",
  );
  assert.equal(adopted.record.projectId, first.vaultState.project.projectId);
  assert.equal(await snapshot(adopted.vaultDir), originals[0]);
  assert.equal(
    await snapshot(adopted.workingFolders["branch-main"]!),
    originals[1],
  );
  assert.equal(
    await snapshot(adopted.workingFolders[branch.branch.branchId]!),
    originals[2],
  );
  assert.deepEqual(
    await Promise.all([
      snapshot(vault),
      snapshot(main),
      snapshot(branch.workingDir),
    ]),
    originals,
  );
  const scan = await scanBranchChanges(
    adopted.workingFolders["branch-main"]!,
    "branch-main",
    getBranchBaseline(adopted.vaultState, "branch-main"),
  );
  assert.ok(scan.added.some((file) => file.path === "Uncaptured.bin"));
  const next = await captureRevision(
    adopted.workingFolders["branch-main"]!,
    adopted.vaultDir,
    {
      branchId: "branch-main",
      summary: "After adoption",
      notes,
      workingFolders: adopted.workingFolders,
    },
  );
  assert.equal(next.revision.manifest.displayNumber, 2);
  assert.equal(
    next.revision.manifest.parentRevisionId,
    first.revision.manifest.revisionId,
  );
  assert.deepEqual(
    await Promise.all([
      snapshot(vault),
      snapshot(main),
      snapshot(branch.workingDir),
    ]),
    originals,
  );
  await assert.rejects(
    adoptProject(root, vault, folders),
    /already has a managed location/,
  );
});

test("malformed mappings, unknown schemas, permission loss, and overlapping branch bindings block managed writes early", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  let project = await importProject(root, await cadSource(), "Actuator");
  const first = await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes },
  );
  project = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId,
    name: "Case A",
    reason: "Alternative",
  });
  const branch = project.vaultState.branches.find((entry) => !entry.isMain)!;
  const container = await root.getDirectory(
    project.record.containerPath.split("/"),
  );
  const mappingPath = [".cadtree", "branches", `${branch.branchId}.json`];
  const original = await container.readFileText(mappingPath);
  for (const change of [
    { schemaVersion: 99 },
    { workingPath: project.workingPaths["branch-main"] },
    { branchId: "wrong-identity" },
  ]) {
    const mapping = { ...JSON.parse(original), ...change };
    mapping.payloadSha256 = managementChecksum(mapping);
    await container.writeFileText(mappingPath, JSON.stringify(mapping));
    const readOnly = await resolveManagedProject(
      root,
      project.record.containerPath,
    );
    assert.ok(readOnly.issues.length);
    await assert.rejects(
      createManagedBranch(root, project.record.containerPath, {
        sourceRevisionId: first.revision.manifest.revisionId,
        name: "Blocked",
        reason: "Must fail early",
      }),
      /read-only/,
    );
    await assert.rejects(
      recoverManagedCopy(
        root,
        project.record.containerPath,
        first.revision.manifest.revisionId,
        undefined,
      ),
      /read-only/,
    );
  }
  await container.writeFileText(mappingPath, original);
  const workspaceRecord = JSON.parse(
    await root.readFileText([".cadtree-workspace.json"]),
  );
  const newer = { ...workspaceRecord, schemaVersion: 2 };
  newer.payloadSha256 = managementChecksum(newer);
  await root.writeFileText([".cadtree-workspace.json"], JSON.stringify(newer));
  await assert.rejects(openWorkspace(root), /Unsupported workspace schema/);
  await root.writeFileText(
    [".cadtree-workspace.json"],
    JSON.stringify(workspaceRecord),
  );
  root.setHooks({ readPermission: "denied" });
  await assert.rejects(openWorkspace(root), /Permission denied/);
  root.setHooks({ readPermission: "granted" });
  assert.equal((await openWorkspace(root)).projects[0].status, "ready");
});

test("duplicate project identities are discovered as alternative locations, not independent histories", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await importProject(root, await cadSource(), "Actuator");
  const oldContainer = await root.getDirectory(
    project.record.containerPath.split("/"),
  );
  const newPath = "projects/explicit-duplicate";
  const duplicate = await root.getDirectory(newPath.split("/"), {
    create: true,
  });
  await copyVerifiedTree(oldContainer, duplicate);
  // An exact copy keeps the same project identity. Under location-independent identity
  // no record rewriting is needed (or trusted): both locations are duplicates, never merged.
  const state = await openWorkspace(root);
  assert.equal(state.projects.length, 2);
  assert.ok(state.projects.every((entry) => entry.status === "duplicate"));
  assert.equal(new Set(state.projects.map((entry) => entry.projectId)).size, 1);
  assert.ok(
    state.projects.every((entry) =>
      entry.issues.some((issue) =>
        issue.includes("Choose one location explicitly"),
      ),
    ),
  );
  assert.deepEqual(
    state.projects.map((entry) => entry.containerPath).sort(),
    [project.record.containerPath, newPath].sort(),
  );
});

test("project ready acknowledgement errors and convenience-independent discovery do not duplicate publication", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  root.setHooks({
    onAfterWrite: (path) => {
      if (path.endsWith("/.cadtree/ready.json"))
        throw new Error("Lost write acknowledgement");
    },
  });
  const project = await importProject(root, await cadSource(), "Actuator");
  assert.equal(project.ready, true);
  assert.equal(
    (await openWorkspace(root)).projects.filter(
      (entry) => entry.status === "ready",
    ).length,
    1,
  );
  await assert.rejects(
    importProject(root, await cadSource(), "Actuator"),
    /already present/,
  );
});

test("interruption at project publication and branch mapping leaves no ready alternative and retry never reuses a destination", async () => {
  for (const failure of ["import-ready", "branch-mapping"]) {
    const root = new InMemoryFileSystemAdapter("Workspace");
    await createWorkspace(root);
    const source = await cadSource();
    if (failure === "import-ready") {
      const controller = new AbortController();
      await assert.rejects(
        importProject(root, source, "Retry", {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.message === "Publishing the verified managed project…")
              controller.abort();
          },
        }),
      );
      assert.equal(
        (await openWorkspace(root)).projects[0].status,
        "incomplete",
      );
      await importProject(root, source, "Retry");
      assert.equal((await root.getDirectory(["projects"])).name, "projects");
      assert.equal((await openWorkspace(root)).projects.length, 2);
    } else {
      const project = await importProject(root, source, "Actuator");
      const saved = await captureRevision(
        project.workingFolders["branch-main"]!,
        project.vaultDir,
        { branchId: "branch-main", summary: "Baseline", notes },
      );
      root.setHooks({
        onBeforeWrite: (path) => {
          if (
            path.includes("/.cadtree/branches/") &&
            !path.endsWith("branch-main.json")
          )
            throw new Error("Mapping publication failed");
        },
      });
      await assert.rejects(
        createManagedBranch(root, project.record.containerPath, {
          sourceRevisionId: saved.revision.manifest.revisionId,
          name: "Case A",
          reason: "Retry mapping",
        }),
      );
      assert.equal(
        (await openExistingVault(project.vaultDir)).branches.length,
        1,
      );
      root.setHooks({ onBeforeWrite: undefined });
      await createManagedBranch(root, project.record.containerPath, {
        sourceRevisionId: saved.revision.manifest.revisionId,
        name: "Case A",
        reason: "Retry mapping",
      });
      assert.equal(
        (await openExistingVault(project.vaultDir)).branches.length,
        2,
      );
      const working = await root.getDirectory(
        (project.record.containerPath + "/working").split("/"),
      );
      assert.equal((await working.listEntries()).length, 3);
    }
  }
});

test("adoption refuses missing source bindings, cancellation, source changes, and corrupt established markers without changing originals", async () => {
  for (const mode of ["missing", "cancel", "source-change", "marker"]) {
    const root = new InMemoryFileSystemAdapter("Workspace");
    await createWorkspace(root);
    const main = await cadSource();
    const vault = new InMemoryFileSystemAdapter("Old vault");
    await initializeProjectVault(main, vault, "Legacy");
    const saved = await captureRevision(main, vault, {
      branchId: "branch-main",
      summary: "Baseline",
      notes,
    });
    const branch = await createDesignBranch({
      vaultDir: vault,
      destinationParent: new InMemoryFileSystemAdapter("Old cases"),
      workingFolders: { "branch-main": main },
      sourceRevisionId: saved.revision.manifest.revisionId,
      name: "Case A",
      reason: "Test fault",
    });
    const folders = {
      "branch-main": main,
      [branch.branch.branchId]: branch.workingDir,
    };
    if (mode === "marker") {
      await branch.workingDir.writeFileBytes(["Extra"], new Uint8Array([3]));
      await captureRevision(branch.workingDir, vault, {
        branchId: branch.branch.branchId,
        summary: "Established",
        notes,
        workingFolders: folders,
      });
      await vault.writeFileText(
        ["branches", `${branch.branch.branchId}.ready.json`],
        "{",
      );
    }
    const before = await snapshot(vault);
    const controller = new AbortController();
    let changed = false;
    root.setHooks({
      onBeforeWrite: async (path) => {
        if (
          mode === "source-change" &&
          path.endsWith("/.cadtree/project.json") &&
          !changed
        ) {
          changed = true;
          await main.writeFileBytes(["Late change"], new Uint8Array([3]));
        }
      },
    });
    await assert.rejects(
      adoptProject(
        root,
        vault,
        mode === "missing" ? { "branch-main": main } : folders,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (mode === "cancel" && progress.phase === "restoring_files")
              controller.abort();
          },
        },
      ),
    );
    assert.equal(await snapshot(vault), before);
    assert.ok(
      (await openWorkspace(root)).projects.every(
        (entry) => entry.status !== "ready",
      ),
    );
  }
});

test("concurrent managed branch creation resolves the latest portable bindings under the project lock", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await importProject(root, await cadSource(), "Actuator");
  const first = await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes },
  );
  const results = await Promise.all(
    ["Case A", "Case B"].map((name) =>
      createManagedBranch(root, project.record.containerPath, {
        sourceRevisionId: first.revision.manifest.revisionId,
        name,
        reason: "Parallel request",
      }),
    ),
  );
  assert.equal(results.length, 2);
  const reopened = await resolveManagedProject(
    root,
    project.record.containerPath,
  );
  assert.equal(reopened.vaultState.branches.length, 3);
  assert.equal(Object.keys(reopened.workingFolders).length, 3);
  assert.equal(reopened.vaultState.revisions.length, 1);
});

test("adoption rejects corrupt stored content even when its raw copied bytes match the source vault", async () => {
  const main = await cadSource(),
    vault = new InMemoryFileSystemAdapter("Old vault");
  await initializeProjectVault(main, vault, "Legacy");
  const revision = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Baseline",
    notes,
  });
  const file = revision.revision.manifest.files.find(
    (entry) => entry.size > 0,
  )!;
  await vault.writeFileBytes(
    getObjectPathSegments(file.sha256),
    new Uint8Array([7]),
  );
  const before = await snapshot(vault);
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  await assert.rejects(
    adoptProject(root, vault, { "branch-main": main }),
    /corrupt stored objects/,
  );
  assert.ok(
    (await openWorkspace(root)).projects.every(
      (entry) => entry.status !== "ready",
    ),
  );
  assert.equal(await snapshot(vault), before);
});

test("managed cases get readable working folders; 'main.' never takes working/main; adoption keeps readable names", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  let project = await importProject(root, await cadSource(), "Actuator");
  const first = await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes, workingFolders: project.workingFolders },
  );
  const made: Record<string, string> = {};
  for (const name of ["Lighter collar", "Lighter/collar", "Lighter-collar", "main.", "CON"]) {
    const created = await createManagedBranch(root, project.record.containerPath, {
      sourceRevisionId: first.revision.manifest.revisionId,
      name,
      reason: "Explore",
    });
    project = created;
    made[name] = created.workingPaths[created.createdBranchId];
  }
  const base = project.record.containerPath + "/working/";
  assert.equal(project.workingPaths["branch-main"], base + "main");
  assert.deepEqual(made, {
    "Lighter collar": base + "Lighter collar",
    "Lighter/collar": base + "Lighter-collar",
    "Lighter-collar": base + "Lighter-collar (2)",
    "main.": base + "main (2)",
    CON: base + "CON (2)",
  });
  // Importing the complete managed project into another workspace re-adopts it.
  const other = new InMemoryFileSystemAdapter("Other workspace");
  await createWorkspace(other);
  const source = await root.getDirectory(project.record.containerPath.split("/"));
  const imported = await importProject(other, source, "ignored");
  const leaves = Object.values(imported.workingPaths)
    .map((path) => path.split("/").pop())
    .sort();
  assert.deepEqual(
    leaves,
    ["CON (2)", "Lighter-collar", "Lighter-collar (2)", "Lighter collar", "main", "main (2)"].sort(),
  );
});

test("a Unicode case name is bound at its exact working path and reopens ready", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await importProject(root, await cadSource(), "Actuator");
  const first = await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes, workingFolders: project.workingFolders },
  );
  const created = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId,
    name: "Ünïcode 設計 案",
    reason: "Explore",
  });
  const expected = `${project.record.containerPath}/working/Ünïcode 設計 案`;
  assert.equal(created.workingPaths[created.createdBranchId], expected);
  const reopened = await resolveManagedProject(root, project.record.containerPath);
  assert.ok(reopened.ready);
  assert.equal(reopened.issues.length, 0);
  assert.equal(reopened.workingPaths[created.createdBranchId], expected);
  assert.ok(reopened.workingFolders[created.createdBranchId]);
  const listed = (await openWorkspace(root)).projects[0].project!;
  assert.ok(listed.ready);
  assert.ok(listed.workingFolders[created.createdBranchId]);
});

test("renaming a project folder in the file explorer keeps the project ready and writable", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  let project = await createProject(root, "Packaging Gripper");
  await project.workingFolders["branch-main"]!.writeFileBytes(["Part.SLDPRT"], new Uint8Array([1, 2, 3]));
  const first = await captureRevision(project.workingFolders["branch-main"]!, project.vaultDir, {
    branchId: "branch-main", summary: "Baseline", notes, workingFolders: project.workingFolders,
  });
  project = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId, name: "Lighter collar", reason: "Explore",
  });
  const projectId = project.record.projectId;
  const oldPath = project.record.containerPath;
  // The in-memory adapter has no move: recreate the tree under the new name, then remove the original.
  const renamed = "projects/Renamed gripper";
  const target = await root.getDirectory(renamed.split("/"), { create: true });
  await copyVerifiedTree(await root.getDirectory(oldPath.split("/")), target);
  await root.removeEntry(oldPath.split("/"), { recursive: true });

  const state = await openWorkspace(root);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].status, "ready");
  assert.equal(state.projects[0].projectId, projectId);
  assert.equal(state.projects[0].containerPath, renamed);
  const resolved = await resolveManagedProject(root, renamed);
  assert.deepEqual(resolved.issues, []);
  assert.equal(resolved.record.containerPath, renamed);
  assert.equal(resolved.record.vaultPath, renamed + "/vault");
  assert.equal(resolved.record.projectId, projectId);
  assert.equal(resolved.vaultState.project.projectId, projectId);
  assert.equal(Object.keys(resolved.workingPaths).length, 2);
  for (const path of Object.values(resolved.workingPaths))
    assert.ok(path.startsWith(renamed + "/working/"), path);
  // The stored record on disk is untouched (the ready marker covers it).
  const stored = JSON.parse(await target.readFileText([".cadtree", "project.json"]));
  assert.equal(stored.containerPath, oldPath);

  const another = await createManagedBranch(root, resolved.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId, name: "Case B", reason: "More",
  });
  assert.ok(another.workingPaths[another.createdBranchId].startsWith(renamed + "/working/"));
  await save(another, "branch-main", 77);
  const reopened = await openWorkspace(root);
  assert.equal(reopened.projects[0].status, "ready");
  assert.equal(reopened.projects[0].project!.vaultState.branches.length, 3);
});

test("renamed incomplete folders are still labelled from attempt.json", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const dir = await root.getDirectory(["projects", "Hand renamed"], { create: true });
  await dir.writeFileText([".cadtree", "attempt.json"], JSON.stringify({
    operation: "create", name: "Half made", containerPath: "projects/Half made",
  }));
  const entry = (await openWorkspace(root)).projects[0];
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.name, "Half made");
});

test("tampering is still rejected under location-independent project identity", async () => {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await importProject(root, await cadSource(), "Actuator");
  const first = await captureRevision(project.workingFolders["branch-main"]!, project.vaultDir, {
    branchId: "branch-main", summary: "Baseline", notes, workingFolders: project.workingFolders,
  });
  const withCase = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId, name: "Case A", reason: "Alt",
  });
  const containerPath = project.record.containerPath;
  const container = await root.getDirectory(containerPath.split("/"));
  const recordPath = [".cadtree", "project.json"];
  const originalRecord = await container.readFileText(recordPath);

  // Another workspaceId in project.json (even with a valid checksum) is not this workspace's project.
  const foreign = { ...JSON.parse(originalRecord), workspaceId: "other-workspace" };
  foreign.payloadSha256 = managementChecksum(foreign);
  await container.writeFileText(recordPath, JSON.stringify(foreign));
  await assert.rejects(resolveManagedProject(root, containerPath), /does not match this workspace/);
  assert.equal((await openWorkspace(root)).projects[0].status, "damaged");

  // A changed record no longer matches the ready marker hash: not ready, never silently accepted.
  const edited = { ...JSON.parse(originalRecord), name: "Edited" };
  edited.payloadSha256 = managementChecksum(edited);
  await container.writeFileText(recordPath, JSON.stringify(edited));
  const unready = await resolveManagedProject(root, containerPath);
  assert.equal(unready.ready, false);
  assert.equal((await openWorkspace(root)).projects[0].status, "incomplete");
  await container.writeFileText(recordPath, originalRecord);
  assert.equal((await resolveManagedProject(root, containerPath)).issues.length, 0);

  const caseId = withCase.createdBranchId;
  const caseLeaf = withCase.workingPaths[caseId].split("/").pop()!;
  const mainPath = [".cadtree", "branches", "branch-main.json"];
  const casePath = [".cadtree", "branches", `${caseId}.json`];
  const mainOriginal = await container.readFileText(mainPath);
  const caseOriginal = await container.readFileText(casePath);
  const write = async (path: string[], base: string, workingPath: string) => {
    const modified = { ...JSON.parse(base), workingPath };
    modified.payloadSha256 = managementChecksum(modified);
    await container.writeFileText(path, JSON.stringify(modified));
  };
  const working = await container.getDirectory(["working"]);
  const foldersBefore = (await working.listEntries()).map((e) => e.name).sort();
  for (const bad of [
    "projects/x/main",
    "projects/x/vault/main",
    "projects/x/working/main/deeper",
    "other/x/working/main",
    "projects/x/working/ma:in",
    "projects/x/working/..",
    "projects/x/working",
  ]) {
    await write(mainPath, mainOriginal, bad);
    const state = await resolveManagedProject(root, containerPath);
    assert.ok(state.issues.length, bad);
    assert.equal(state.workingFolders["branch-main"], undefined, bad);
  }
  // Leaves differing only by case collide.
  await write(mainPath, mainOriginal, `projects/anything/working/${caseLeaf.toUpperCase()}`);
  await write(casePath, caseOriginal, `projects/other/working/${caseLeaf.toLowerCase()}`);
  const collided = await resolveManagedProject(root, containerPath);
  assert.ok(collided.issues.some((issue) => /collision|Case-insensitive/i.test(issue)));
  // A leaf whose folder is missing is reported and never created.
  await write(mainPath, mainOriginal, "projects/anything/working/Missing leaf");
  await write(casePath, caseOriginal, withCase.workingPaths[caseId]);
  const missing = await resolveManagedProject(root, containerPath);
  assert.ok(missing.issues.some((issue) => issue.includes("No folder was recreated")));
  assert.equal(missing.workingFolders["branch-main"], undefined);
  assert.deepEqual((await working.listEntries()).map((e) => e.name).sort(), foldersBefore);
});

async function renamedProjectWithCase() {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  let project = await createProject(root, "Alpha");
  await project.workingFolders["branch-main"]!.writeFileBytes(["Part.SLDPRT"], new Uint8Array([9, 8, 7]));
  const first = await captureRevision(project.workingFolders["branch-main"]!, project.vaultDir, {
    branchId: "branch-main", summary: "Baseline", notes, workingFolders: project.workingFolders,
  });
  const oldPath = project.record.containerPath;
  const renamed = "projects/Renamed alpha";
  const target = await root.getDirectory(renamed.split("/"), { create: true });
  await copyVerifiedTree(await root.getDirectory(oldPath.split("/")), target);
  await root.removeEntry(oldPath.split("/"), { recursive: true });
  project = await resolveManagedProject(root, renamed);
  return { root, project, first, renamed, target };
}

test("a renamed project with a new case imports into another workspace as a ready project with readable leaves", async () => {
  const { root, project, first, renamed } = await renamedProjectWithCase();
  const withCase = await createManagedBranch(root, renamed, {
    sourceRevisionId: first.revision.manifest.revisionId, name: "Lighter collar", reason: "Explore",
  });
  const other = new InMemoryFileSystemAdapter("Other workspace");
  await createWorkspace(other);
  const imported = await importProject(other, await root.getDirectory(renamed.split("/")), "ignored");
  assert.equal(imported.ready, true);
  assert.deepEqual(imported.issues, []);
  assert.equal(imported.record.projectId, project.record.projectId);
  assert.equal(Object.keys(imported.workingPaths).length, 2);
  assert.deepEqual(
    Object.values(imported.workingPaths).map((path) => path.split("/").pop()).sort(),
    ["Lighter collar", "main"],
  );
  assert.ok(withCase.workingPaths[withCase.createdBranchId].startsWith(renamed + "/working/"));
  const reopened = (await openWorkspace(other)).projects;
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].status, "ready");
});

test("recovery copies on a renamed project land under its current folder and the project reopens ready", async () => {
  const { root, first, renamed } = await renamedProjectWithCase();
  const recovered = await recoverManagedCopy(root, renamed, first.revision.manifest.revisionId, undefined);
  assert.ok(recovered);
  const recoveries = await root.getDirectory([...renamed.split("/"), "recoveries"]);
  assert.equal((await recoveries.listEntries()).length, 1);
  const entry = (await openWorkspace(root)).projects[0];
  assert.equal(entry.status, "ready");
  assert.equal(entry.containerPath, renamed);
});

test("import rejects a source whose branch locations share a leaf case-insensitively and writes nothing", async () => {
  const { root, first, renamed, target } = await renamedProjectWithCase();
  const withCase = await createManagedBranch(root, renamed, {
    sourceRevisionId: first.revision.manifest.revisionId, name: "Case A", reason: "Alt",
  });
  const caseId = withCase.createdBranchId;
  const casePath = [".cadtree", "branches", `${caseId}.json`];
  const mapping = JSON.parse(await target.readFileText(casePath));
  mapping.workingPath = "projects/Renamed alpha/working/MAIN";
  mapping.payloadSha256 = managementChecksum(mapping);
  await target.writeFileText(casePath, JSON.stringify(mapping));
  const other = new InMemoryFileSystemAdapter("Other workspace");
  await createWorkspace(other);
  await assert.rejects(importProject(other, target, "ignored"), /collide/);
  const projects = (await openWorkspace(other)).projects;
  assert.equal(projects.filter((entry) => entry.status === "ready").length, 0);
  assert.equal(projects.length, 0);
});
