import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import {
  createWorkspace,
  openWorkspace,
  importProject,
  resolveManagedProject,
  createManagedBranch,
  recoverManagedCopy,
  adoptProject,
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
    assert.equal(failed.projects.length, 1);
    assert.equal(failed.projects[0].status, "incomplete");
    source.setHooks({ readPermission: "granted" });
    root.setHooks({ onBeforeWrite: undefined });
    const retry = await importProject(root, source, "Retry project");
    assert.notEqual(
      retry.record.containerPath,
      failed.projects[0].containerPath,
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
  const record = {
    ...project.record,
    containerPath: newPath,
    vaultPath: `${newPath}/vault`,
  };
  record.payloadSha256 = managementChecksum(record);
  const text = JSON.stringify(record);
  await duplicate.writeFileText([".cadtree", "project.json"], text);
  const mapping = JSON.parse(
    await duplicate.readFileText([".cadtree", "branches", "branch-main.json"]),
  );
  mapping.workingPath = `${newPath}/working/main`;
  mapping.payloadSha256 = managementChecksum(mapping);
  await duplicate.writeFileText(
    [".cadtree", "branches", "branch-main.json"],
    JSON.stringify(mapping),
  );
  await duplicate.writeFileText(
    [".cadtree", "ready.json"],
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      recordSha256: hashString(text),
    }),
  );
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
            path.includes("/.cadtree/branches/branch-") &&
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
