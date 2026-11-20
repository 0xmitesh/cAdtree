import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFolderPath as normalizeWindowsWorkspacePath,
  composeFilePaths as composeWindowsFilePaths,
} from "../utils/folder-path";
import {
  resolveWorkingFilePath,
} from "./path-shortcuts";
import { InMemoryFileSystemAdapter } from "./fs-adapter";
import {
  createWorkspace,
  importProject,
  createManagedBranch,
  managementChecksum,
} from "./workspace-service";
import { captureRevision } from "./revision-service";
import { readVerifiedInventory, inventorySignature } from "./copy-service";
import { MAIN_BRANCH_ID } from "./types";

test("Windows roots normalize drive roots, quotes, spaces, Unicode, separators, and UNC shares without shell syntax", () => {
  for (const [input, expected] of [
    ["", ""],
    ["   ", ""],
    ['  "d:\\CAD Workspace\\设计\\"  ', "D:\\CAD Workspace\\设计"],
    ["c:/", "C:\\"],
    ["D:\\", "D:\\"],
    ["D:\\CAD\\\\", "D:\\CAD"],
    ["'e:\\Designs'", "E:\\Designs"],
    ["\\\\server\\share\\", "\\\\server\\share"],
    ["\\\\server\\share\\CAD 工程", "\\\\server\\share\\CAD 工程"],
  ])
    assert.equal(normalizeWindowsWorkspacePath(input), expected, input);
  const location = {
    workspaceId: "workspace",
    relativeDirectory: "projects/unchanged-record/working/custom-leaf",
    filePath: "Parts/嵌套/Bracket.SLDPRT",
  };
  assert.deepEqual(composeWindowsFilePaths('"D:\\CAD Workspace\\"', location), {
    file: "D:\\CAD Workspace\\projects\\unchanged-record\\working\\custom-leaf\\Parts\\嵌套\\Bracket.SLDPRT",
    folder:
      "D:\\CAD Workspace\\projects\\unchanged-record\\working\\custom-leaf\\Parts\\嵌套",
  });
  assert.equal(
    composeWindowsFilePaths("C:\\", { ...location, filePath: "Part" }).folder,
    "C:\\projects\\unchanged-record\\working\\custom-leaf",
  );
  assert.equal(
    composeWindowsFilePaths("\\\\srv\\share\\", location).file,
    "\\\\srv\\share\\projects\\unchanged-record\\working\\custom-leaf\\Parts\\嵌套\\Bracket.SLDPRT",
  );
});

test("path shortcuts reject relative, URL, traversal, device, malformed, and unsafe file paths", () => {
  for (const input of [
    "CAD",
    "C:CAD",
    "\\CAD",
    "https://example.com",
    "//example.com/path",
    "file:///D:/CAD",
    "D:\\a\\..\\b",
    "D:\\.\\a",
    "D:\\a\\\\b",
    "D:\\folder.",
    "D:\\folder \\x",
    'D:\\bad"name',
    "D:\\nul.txt",
    "D:\\COM¹",
    "D:\\x:y",
    "D:\\x\n",
    "\\\\server",
    "\\\\?\\C:\\CAD",
    "\\\\.\\drive",
    "\\\\srv\\share\\..",
    '"D:\\CAD',
  ]) {
    assert.throws(() => normalizeWindowsWorkspacePath(input), input);
  }
  for (const filePath of [
    "../Part",
    "/Part",
    "Parts\\Part",
    "Part:stream",
    "Parts/../Part",
    "CON",
    "Part?",
    "",
  ]) {
    assert.throws(() =>
      composeWindowsFilePaths("D:\\CAD", {
        workspaceId: "w",
        relativeDirectory: "projects/p/working/main",
        filePath,
      }),
    );
  }
  assert.throws(() =>
    composeWindowsFilePaths("D:\\CAD", {
      workspaceId: "w",
      relativeDirectory: "../vault",
      filePath: "Part",
    }),
  );
});

async function fixture() {
  const root = new InMemoryFileSystemAdapter("Root");
  const workspace = await createWorkspace(root);
  const source = new InMemoryFileSystemAdapter("Source");
  await source.writeFileText(["Parts", "Nested", "Bracket.SLDPRT"], "baseline");
  const project = await importProject(root, source, "Readable display name");
  const captured = await captureRevision(
    project.workingFolders[MAIN_BRANCH_ID]!,
    project.vaultDir,
    {
      branchId: MAIN_BRANCH_ID,
      summary: "Baseline",
      notes: { problem: "", modification: "", observations: "" },
    },
  );
  const branch = await createManagedBranch(root, project.record.containerPath, {
    sourceRevisionId: captured.revision.manifest.revisionId,
    name: "Case A",
    reason: "Explore",
  });
  return {
    root,
    workspaceId: workspace.identity.workspaceId,
    project: branch,
    revisionId: captured.revision.manifest.revisionId,
  };
}

test("working shortcuts use validated on-disk branch mappings, not display names or the active branch, and never write", async () => {
  const { root, workspaceId, project } = await fixture();
  const branchId = project.createdBranchId;
  // Use a valid, non-generated leaf name to ensure consumers do not infer slugs.
  const customPath = `${project.record.containerPath}/working/Independent CAD copy`;
  const custom = await root.getDirectory(customPath.split("/"), {
    create: true,
  });
  await custom.writeFileText(
    ["Parts", "Nested", "Bracket.SLDPRT"],
    "uncaptured edits",
  );
  const mappingPath = [
    ...project.record.containerPath.split("/"),
    ".cadtree",
    "branches",
    `${branchId}.json`,
  ];
  const record = JSON.parse(await root.readFileText(mappingPath));
  record.workingPath = customPath;
  record.payloadSha256 = managementChecksum(record);
  await root.writeFileText(mappingPath, JSON.stringify(record));
  const before = inventorySignature(await readVerifiedInventory(root));
  const main = await resolveWorkingFilePath(
    root,
    workspaceId,
    project.record.containerPath,
    MAIN_BRANCH_ID,
    "Parts/Nested/Bracket.SLDPRT",
  );
  const other = await resolveWorkingFilePath(
    root,
    workspaceId,
    project.record.containerPath,
    branchId,
    "Parts/Nested/Bracket.SLDPRT",
  );
  assert.equal(main.relativeDirectory, project.workingPaths[MAIN_BRANCH_ID]);
  assert.equal(other.relativeDirectory, customPath);
  assert.match(
    composeWindowsFilePaths("D:\\Root", other).file,
    /Independent CAD copy\\Parts\\Nested\\Bracket.SLDPRT$/,
  );
  assert.equal(inventorySignature(await readVerifiedInventory(root)), before);
  await custom.removeEntry(["Parts", "Nested", "Bracket.SLDPRT"]);
  await assert.rejects(
    resolveWorkingFilePath(
      root,
      workspaceId,
      project.record.containerPath,
      branchId,
      "Parts/Nested/Bracket.SLDPRT",
    ),
    /missing|cannot be read/,
  );
  await assert.rejects(
    resolveWorkingFilePath(
      root,
      workspaceId,
      project.record.containerPath,
      "not-a-branch",
      "Parts/Nested/Bracket.SLDPRT",
    ),
    /not connected/,
  );
  await root.removeEntry(customPath.split("/"), { recursive: true });
  await assert.rejects(
    resolveWorkingFilePath(
      root,
      workspaceId,
      project.record.containerPath,
      branchId,
      "Parts/Nested/Bracket.SLDPRT",
    ),
    /locations need attention/,
  );
  assert.equal(await root.hasDirectory(customPath.split("/")), false);
});
